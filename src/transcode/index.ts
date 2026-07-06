// Post-download normalization to a compact, universally browser-playable format:
// MP4 / H.264 (High, 8-bit yuv420p) / AAC, +faststart, downscaled to keep files small. We must stay
// H.264/AAC (that's what browsers play), so compactness comes from resolution + CRF, not a better
// codec. Everything is re-encoded (no fast remux) to guarantee the size reduction.
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { statSync } from "node:fs";
import { logger } from "../logger.ts";

const log = logger("transcode");
const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = (ffprobeStatic as { path: string }).path;

// Compact-conversion knobs (env-tunable). Higher CRF = smaller + lower quality; lower height = smaller.
const MAX_HEIGHT = Number(process.env.CONVERT_MAX_HEIGHT) || 720;
const CRF = String(Number(process.env.CONVERT_CRF) || 26);
// veryfast keeps encoding tractable on modest CPUs; the 720p downscale + CRF do most of the size win.
// (Slower presets like "medium"/"slow" shave a bit more size but are much slower.)
const PRESET = process.env.CONVERT_PRESET || "veryfast";
const AUDIO_KBPS = String(Number(process.env.CONVERT_AUDIO_KBPS) || 128);

export type Probe = { videoCodec: string | null; audioCodec: string | null; durationSec: number };

export async function probe(input: string): Promise<Probe> {
  const proc = Bun.spawn([FFPROBE, "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", input], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const data = JSON.parse(out || "{}");
  const streams: any[] = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  return {
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    durationSec: Number(data.format?.duration) || 0,
  };
}

/**
 * Convert `input` to a compact, browser-safe MP4 at `output` (H.264/AAC, downscaled to MAX_HEIGHT).
 * Calls onProgress(0..1) as it runs. Throws on failure. Returns the output size in bytes.
 */
export async function normalize(
  input: string,
  output: string,
  onProgress?: (frac: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const info = await probe(input);

  const args = [
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a:0?", // first audio track if present
    "-sn", "-dn", // drop subtitles + data streams
    // Downscale to at most MAX_HEIGHT (never upscale); keep width even. Comma inside min() is escaped.
    "-vf", `scale=-2:'min(${MAX_HEIGHT}\\,ih)'`,
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", PRESET, "-crf", CRF,
    "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`,
    "-movflags", "+faststart",
    output,
  ];
  log.info(`normalizing ${info.videoCodec}/${info.audioCodec} → h264/aac ≤${MAX_HEIGHT}p crf${CRF} (${AUDIO_KBPS}k audio)`);

  const proc = Bun.spawn([FFMPEG, ...args], { stdout: "ignore", stderr: "pipe", signal });

  // Drain stderr (so ffmpeg never blocks) and parse progress from its `time=` output.
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  let tail = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    tail = (tail + chunk).slice(-4000);
    if (onProgress && info.durationSec > 0) {
      let m: RegExpExecArray | null;
      let last: RegExpExecArray | null = null;
      const re = /time=(\d+):(\d+):([\d.]+)/g;
      while ((m = re.exec(chunk))) last = m;
      if (last) {
        const sec = +last[1]! * 3600 + +last[2]! * 60 + parseFloat(last[3]!);
        onProgress(Math.min(0.999, sec / info.durationSec));
      }
    }
  }

  const code = await proc.exited;
  if (code !== 0) {
    const detail = tail.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 300);
    throw new Error(`ffmpeg failed (exit ${code}): ${detail}`);
  }
  return statSync(output).size;
}

// Post-download normalization to the most universally browser-playable format:
// MP4 / H.264 (High, 8-bit yuv420p) / AAC, +faststart. Streams that are already compatible are
// copied (fast remux); only incompatible ones (HEVC, 10-bit, AC-3, etc.) are re-encoded.
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { statSync } from "node:fs";
import { logger } from "../logger.ts";

const log = logger("transcode");
const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = (ffprobeStatic as { path: string }).path;

// Codecs a browser <video> can play directly inside MP4.
const COMPATIBLE_VIDEO = new Set(["h264"]);
const COMPATIBLE_AUDIO = new Set(["aac"]);

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
 * Convert `input` to a browser-safe MP4 at `output`. Copies already-compatible streams; re-encodes
 * the rest. Calls onProgress(0..1) as it runs. Throws on failure. Returns the output size in bytes.
 */
export async function normalize(input: string, output: string, onProgress?: (frac: number) => void): Promise<number> {
  const info = await probe(input);
  const copyVideo = info.videoCodec != null && COMPATIBLE_VIDEO.has(info.videoCodec);
  const copyAudio = info.audioCodec != null && COMPATIBLE_AUDIO.has(info.audioCodec);

  const args = [
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a:0?", // first audio track if present
    "-sn", "-dn", // drop subtitles + data streams
    "-c:v", copyVideo ? "copy" : "libx264",
    ...(copyVideo ? [] : ["-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "21"]),
    "-c:a", copyAudio ? "copy" : "aac",
    ...(copyAudio ? [] : ["-b:a", "192k"]),
    "-movflags", "+faststart",
    output,
  ];
  log.info(`normalizing (${info.videoCodec}/${info.audioCodec} → h264/aac, video ${copyVideo ? "copy" : "encode"}, audio ${copyAudio ? "copy" : "encode"})`);

  const proc = Bun.spawn([FFMPEG, ...args], { stdout: "ignore", stderr: "pipe" });

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

// Download orchestration via in-process WebTorrent. The app owns the torrent lifecycle
// (brief §7.3, §8). NOTE: WebTorrent must be constructed with { utp: false } or Bun panics on
// uv_timer_init (utp-native uses libuv timers Bun lacks). WebRTC is likewise avoided (no wss trackers).
import WebTorrent from "webtorrent";
import type { Torrent } from "webtorrent";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { db } from "../db/index.ts";
import { config } from "../config.ts";
import { logger } from "../logger.ts";
import { ensureActiveDir, activeItemDir, keepOnly, moveFileInto } from "../storage/index.ts";
import { markAvailable, markFailed, markConverting, updateSize, getMedia, createConvertedSibling, updateTitle, type Media } from "../media/index.ts";
import { normalize } from "../transcode/index.ts";

const log = logger("downloads");

const client = new WebTorrent({ utp: false } as ConstructorParameters<typeof WebTorrent>[0]);
client.on("error", (err) => log.error("client error", (err as Error).message));

const PLAYABLE = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ogv", ".ogg"]);

// --- job persistence ---
const insertJob = db.query(
  `INSERT INTO download_jobs (id, media_id, user_id, room_id, source, external_id, status, progress, downloaded_bytes, total_bytes, created_at, updated_at)
   VALUES ($id, $media, $user, $room, $source, $ext, 'active', 0, 0, 0, $now, $now)`,
);
const updateJob = db.query(
  `UPDATE download_jobs SET progress=$p, downloaded_bytes=$dl, total_bytes=$total, updated_at=$now WHERE id=$id`,
);
const finishJob = db.query(
  `UPDATE download_jobs SET status=$status, progress=$p, error=$err, updated_at=$now WHERE id=$id`,
);
const activeMediaWithMagnet = db.query<Media, []>(
  `SELECT * FROM media WHERE state = 'downloading' AND magnet IS NOT NULL`,
);
const anyActiveMedia = db.query<Media, []>(`SELECT * FROM media WHERE state = 'downloading'`);
const convertingMedia = db.query<Media, []>(`SELECT * FROM media WHERE state = 'converting'`);

// --- event fan-out (WS layer subscribes) ---
export type DownloadEvent = {
  type: "progress" | "converting" | "done" | "failed";
  jobId: string;
  mediaId: string;
  roomId: string | null;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
};
type Listener = (ev: DownloadEvent) => void;
const listeners = new Set<Listener>();
export function onDownloadEvent(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit(ev: DownloadEvent) {
  for (const l of listeners) {
    try {
      l(ev);
    } catch (err) {
      log.error("listener error", (err as Error).message);
    }
  }
}

// Minimum size for a video file to count as a real episode/movie (skips samples/extras).
const MIN_EPISODE_BYTES = Number(process.env.MIN_EPISODE_BYTES) || 50 * 1024 * 1024;

/** Video files worth keeping from a torrent — every real episode/movie, minus samples/extras. */
function qualifyingVideoFiles(torrent: Torrent) {
  const vids = torrent.files.filter((f) => {
    const dot = f.name.lastIndexOf(".");
    return dot !== -1 && PLAYABLE.has(f.name.slice(dot).toLowerCase());
  });
  if (!vids.length) return [torrent.files.reduce((a, b) => (b.length > a.length ? b : a))];
  const largest = Math.max(...vids.map((f) => f.length));
  const threshold = Math.max(MIN_EPISODE_BYTES, largest * 0.15);
  const kept = vids.filter((f) => f.length >= threshold).sort((a, b) => b.length - a.length);
  return kept.length ? kept : [vids.sort((a, b) => b.length - a.length)[0]!];
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

// Conversion outputs we must not mistake for a source file during recovery.
const OUTPUT_NAMES = new Set(["video.mp4", "video.stream.mp4"]);

/** All qualifying source video files under a media dir (for recovering an interrupted conversion). */
function findAllSourceVideos(dir: string): string[] {
  const found: { p: string; size: number }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        const dot = e.name.lastIndexOf(".");
        if (dot === -1 || !PLAYABLE.has(e.name.slice(dot).toLowerCase())) continue;
        if (d === dir && OUTPUT_NAMES.has(e.name)) continue; // skip our own (possibly partial) output
        found.push({ p, size: statSync(p).size });
      }
    }
  };
  walk(dir);
  if (!found.length) return [];
  const largest = Math.max(...found.map((f) => f.size));
  const threshold = Math.max(MIN_EPISODE_BYTES, largest * 0.15);
  return found
    .filter((f) => f.size >= threshold)
    .sort((a, b) => b.size - a.size)
    .map((f) => f.p);
}

/** Begin (or resume) a torrent download for an existing 'downloading' media row. */
export function startDownload(opts: {
  media: Media;
  userId: string | null;
  roomId: string | null;
  magnet: string;
}): string {
  const { media, userId, roomId, magnet } = opts;
  const jobId = randomUUID();
  const now = Date.now();
  insertJob.run({
    $id: jobId,
    $media: media.id,
    $user: userId,
    $room: roomId,
    $source: media.source_type,
    $ext: media.external_id,
    $now: now,
  });
  log.info(`download start: media ${media.id} ("${media.title}") job ${jobId}`);

  const path = ensureActiveDir(media.id);
  let lastEmit = 0;
  let sized = false;

  // Download-only. Three layers ensure we never upload file content:
  //   1. `uploads: 0`  — the rechoke algorithm never unchokes a peer, so none can request pieces.
  //   2. re-choke on interest — undoes WebTorrent's automatic unchoke of any interested peer.
  //   3. neutered `wire.piece` — the sole method that transmits piece bytes becomes a no-op, so even
  //      a BEP6 "allowed-fast" request can't leak content. (Unlike uploadLimit, none of this throttles
  //      the tiny protocol/handshake bytes required to stay in the swarm and keep downloading.)
  // Completed torrents are also destroyed in the "done" handler, so nothing is seeded afterward.
  const torrent = client.add(magnet, { path, uploads: 0 } as Parameters<typeof client.add>[1], (t) => {
    // Metadata ready — record total size for quota accounting.
    if (!sized) {
      sized = true;
      updateSize(media.id, Number(t.length) || 0);
    }
  });

  // Enforce download-only on every peer wire (see the comment above).
  torrent.on("wire", (wire: any) => {
    wire.piece = () => {}; // never transmit piece data
    wire.on("interested", () => wire.choke());
  });

  torrent.on("download", () => {
    const nowTs = Date.now();
    if (nowTs - lastEmit < 1000) return; // throttle
    lastEmit = nowTs;
    // Coerce to numbers — torrent.length can be undefined very early, and binding null to a
    // NOT NULL column throws; a throw here would propagate into WebTorrent's wire and stall it.
    const progress = Number(torrent.progress) || 0;
    const downloaded = Number(torrent.downloaded) || 0;
    const total = Number(torrent.length) || 0;
    try {
      updateJob.run({ $p: progress, $dl: downloaded, $total: total, $now: nowTs, $id: jobId });
    } catch (err) {
      log.error("progress update failed", (err as Error).message);
    }
    emit({ type: "progress", jobId, mediaId: media.id, roomId, progress, downloadedBytes: downloaded, totalBytes: total });
  });

  torrent.on("done", () => {
    // One media item per real video file (season pack → one item per episode).
    const sources = qualifyingVideoFiles(torrent).map((f) => join(path, f.path));
    log.info(`download done: media ${media.id} → ${sources.length} file(s); converting`);
    // Files are on disk now; stop networking (also ensures nothing seeds).
    torrent.destroy();
    void finalizeSources(media, jobId, roomId, sources);
  });

  torrent.on("error", (err) => {
    const message = (err as Error).message;
    markFailed(media.id);
    finishJob.run({ $status: "failed", $p: torrent.progress ?? 0, $err: message, $now: Date.now(), $id: jobId });
    log.error(`download failed: media ${media.id}`, message);
    emit({ type: "failed", jobId, mediaId: media.id, roomId, progress: 0, downloadedBytes: 0, totalBytes: 0, error: message });
    torrent.destroy();
  });

  return jobId;
}

/**
 * Finalize a set of downloaded source files. Each becomes its own media item: the source is moved
 * into that item's dir (so it's self-contained and crash-recoverable), then converted sequentially
 * (one ffmpeg at a time). The first file reuses the given media row; the rest get new sibling rows
 * titled after their filename. Used by both the download-done path and boot recovery.
 */
async function finalizeSources(media: Media, jobId: string, roomId: string | null, sources: string[]): Promise<void> {
  const multi = sources.length > 1;

  // Phase 1: create rows and move each source file into its own media dir.
  const items: { m: Media; src: string; jobId: string }[] = [];
  for (let i = 0; i < sources.length; i++) {
    const abs = sources[i]!;
    const title = stripExt(basename(abs));
    const m = i === 0 ? media : createConvertedSibling(media, title);
    if (i === 0 && multi) updateTitle(m.id, title);
    markConverting(m.id);
    const dest = join(ensureActiveDir(m.id), basename(abs));
    if (resolve(abs) !== resolve(dest)) moveFileInto(abs, dest);
    items.push({ m, src: dest, jobId: i === 0 ? jobId : randomUUID() });
  }

  // Phase 2: convert each item sequentially.
  for (const it of items) {
    await convertAndFinish(it.m, it.jobId, roomId, it.src);
  }
}

/** Convert one finished file to a browser-safe MP4, delete the original, then mark it available. */
async function convertAndFinish(media: Media, jobId: string, roomId: string | null, inputAbs: string): Promise<void> {
  const dir = activeItemDir(media.id);
  let output = join(dir, "video.mp4");
  if (resolve(output) === resolve(inputAbs)) output = join(dir, "video.stream.mp4"); // avoid in==out

  markConverting(media.id);
  emit({ type: "converting", jobId, mediaId: media.id, roomId, progress: 0, downloadedBytes: 0, totalBytes: 0 });

  let lastEmit = 0;
  try {
    const size = await normalize(inputAbs, output, (frac) => {
      const now = Date.now();
      if (now - lastEmit < 1000) return;
      lastEmit = now;
      emit({ type: "converting", jobId, mediaId: media.id, roomId, progress: frac, downloadedBytes: 0, totalBytes: 0 });
    });
    keepOnly(media.id, basename(output)); // delete the original torrent files
    markAvailable(media.id, output, size);
    finishJob.run({ $status: "done", $p: 1, $err: null, $now: Date.now(), $id: jobId });
    log.info(`converted media ${media.id} → ${basename(output)} (${size} bytes)`);
    emit({ type: "done", jobId, mediaId: media.id, roomId, progress: 1, downloadedBytes: size, totalBytes: size });
  } catch (err) {
    const message = (err as Error).message;
    markFailed(media.id);
    finishJob.run({ $status: "failed", $p: 0, $err: message, $now: Date.now(), $id: jobId });
    log.error(`conversion failed: media ${media.id}`, message);
    emit({ type: "failed", jobId, mediaId: media.id, roomId, progress: 0, downloadedBytes: 0, totalBytes: 0, error: message });
  }
}

/** On boot, recover anything left mid-flight by a crash/power loss. */
export function resumeDownloads(): void {
  // 1. Resume interrupted downloads from their stored magnet.
  for (const m of activeMediaWithMagnet.all()) {
    log.info(`resuming interrupted download for media ${m.id}`);
    startDownload({ media: m, userId: m.imported_by, roomId: null, magnet: m.magnet! });
  }
  // Anything still 'downloading' without a magnet can't be resumed.
  for (const m of anyActiveMedia.all()) {
    if (!m.magnet) markFailed(m.id);
  }

  // 2. Re-run conversions interrupted mid-encode: the source file is still on disk (originals are
  //    only deleted after a successful conversion), so convert it again.
  for (const m of convertingMedia.all()) {
    const dir = activeItemDir(m.id);
    const sources = existsSync(dir) ? findAllSourceVideos(dir) : [];
    if (sources.length) {
      log.info(`recovering interrupted conversion for media ${m.id} (${sources.length} file(s))`);
      void finalizeSources(m, randomUUID(), null, sources);
    } else {
      log.warn(`no source file found for converting media ${m.id}; marking failed`);
      markFailed(m.id);
    }
  }
}

export function shutdown(): Promise<void> {
  return new Promise((resolve) => client.destroy(() => resolve()));
}

export { getMedia };

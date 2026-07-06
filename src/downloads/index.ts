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
import { markAvailable, markFailed, markConverting, updateSize, getMedia, discardMedia, createConvertedSibling, updateTitle, type Media } from "../media/index.ts";
import { normalize } from "../transcode/index.ts";

const log = logger("downloads");

const client = new WebTorrent({ utp: false } as ConstructorParameters<typeof WebTorrent>[0]);
client.on("error", (err) => log.error("client error", (err as Error).message));

// For aborting in-flight work: the torrent per downloading media, the ffmpeg abort controller per
// converting media, and the set of media ids that have been aborted (checked in async handlers).
const activeTorrents = new Map<string, Torrent>();
const activeConversions = new Map<string, AbortController>();
const aborted = new Set<string>();
const failActiveJob = db.query(`UPDATE download_jobs SET status='failed', error='aborted', updated_at=$now WHERE media_id=$m AND status='active'`);

// Global conversion concurrency limit (ffmpeg is CPU-heavy). Configurable; default 1.
const CONVERT_CONCURRENCY = Math.max(1, Number(process.env.CONVERT_CONCURRENCY) || 1);
let converting = 0;
const convertQueue: { resolve: () => void; reject: (e: unknown) => void }[] = [];

/** Run `fn` in a conversion slot, waiting if we're at the concurrency limit. Abortable while queued. */
async function withConvertSlot<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  if (converting >= CONVERT_CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      convertQueue.push(entry);
      signal.addEventListener(
        "abort",
        () => {
          const i = convertQueue.indexOf(entry);
          if (i >= 0) convertQueue.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
  converting++;
  try {
    return await fn();
  } finally {
    converting--;
    convertQueue.shift()?.resolve();
  }
}

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
  type: "progress" | "converting" | "done" | "failed" | "aborted";
  jobId: string;
  mediaId: string;
  title: string;
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
// Enrich each event with the media's current title (reflects the per-episode rename during a
// multi-file split), so clients don't need to have the row cached. Callers omit `title`.
function emit(ev: Omit<DownloadEvent, "title">) {
  const full: DownloadEvent = { ...ev, title: getMedia(ev.mediaId)?.title ?? "" };
  for (const l of listeners) {
    try {
      l(full);
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

  activeTorrents.set(media.id, torrent);

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
    activeTorrents.delete(media.id);
    if (aborted.has(media.id)) return; // aborted mid-download; cleanup already handled
    // One media item per real video file (season pack → one item per episode).
    const sources = qualifyingVideoFiles(torrent).map((f) => join(path, f.path));
    log.info(`download done: media ${media.id} → ${sources.length} file(s); converting`);
    // Files are on disk now; stop networking (also ensures nothing seeds).
    torrent.destroy();
    void finalizeSources(media, jobId, roomId, sources);
  });

  torrent.on("error", (err) => {
    activeTorrents.delete(media.id);
    torrent.destroy();
    if (aborted.has(media.id)) return;
    const message = (err as Error).message;
    markFailed(media.id);
    finishJob.run({ $status: "failed", $p: torrent.progress ?? 0, $err: message, $now: Date.now(), $id: jobId });
    log.error(`download failed: media ${media.id}`, message);
    emit({ type: "failed", jobId, mediaId: media.id, roomId, progress: 0, downloadedBytes: 0, totalBytes: 0, error: message });
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

  // Phase 2: convert every item, gated by the global conversion-concurrency limit.
  await Promise.all(items.map((it) => convertAndFinish(it.m, it.jobId, roomId, it.src)));
}

/** Convert one finished file to a browser-safe MP4, delete the original, then mark it available. */
async function convertAndFinish(media: Media, jobId: string, roomId: string | null, inputAbs: string): Promise<void> {
  if (aborted.has(media.id)) return;
  const dir = activeItemDir(media.id);
  let output = join(dir, "video.mp4");
  if (resolve(output) === resolve(inputAbs)) output = join(dir, "video.stream.mp4"); // avoid in==out

  const ctrl = new AbortController();
  activeConversions.set(media.id, ctrl);
  markConverting(media.id);
  emit({ type: "converting", jobId, mediaId: media.id, roomId, progress: 0, downloadedBytes: 0, totalBytes: 0 });

  let lastEmit = 0;
  try {
    const size = await withConvertSlot(ctrl.signal, () =>
      normalize(
        inputAbs,
        output,
        (frac) => {
          const now = Date.now();
          if (now - lastEmit < 1000) return;
          lastEmit = now;
          emit({ type: "converting", jobId, mediaId: media.id, roomId, progress: frac, downloadedBytes: 0, totalBytes: 0 });
        },
        ctrl.signal,
      ),
    );
    keepOnly(media.id, basename(output)); // delete the original source file(s)
    markAvailable(media.id, output, size);
    finishJob.run({ $status: "done", $p: 1, $err: null, $now: Date.now(), $id: jobId });
    log.info(`converted media ${media.id} → ${basename(output)} (${size} bytes)`);
    emit({ type: "done", jobId, mediaId: media.id, roomId, progress: 1, downloadedBytes: size, totalBytes: size });
  } catch (err) {
    if (aborted.has(media.id) || ctrl.signal.aborted) return; // aborted → abortMedia handled cleanup
    const message = (err as Error).message;
    markFailed(media.id);
    finishJob.run({ $status: "failed", $p: 0, $err: message, $now: Date.now(), $id: jobId });
    log.error(`conversion failed: media ${media.id}`, message);
    emit({ type: "failed", jobId, mediaId: media.id, roomId, progress: 0, downloadedBytes: 0, totalBytes: 0, error: message });
  } finally {
    activeConversions.delete(media.id);
  }
}

/** Cancel an in-flight download or conversion for a media item and remove it entirely. */
export function abortMedia(mediaId: string): boolean {
  const m = getMedia(mediaId);
  if (!m || (m.state !== "downloading" && m.state !== "converting")) return false;
  aborted.add(mediaId);

  const torrent = activeTorrents.get(mediaId);
  if (torrent) {
    activeTorrents.delete(mediaId);
    try {
      torrent.destroy();
    } catch { /* already gone */ }
  }
  activeConversions.get(mediaId)?.abort(); // kills ffmpeg or dequeues a waiting conversion

  failActiveJob.run({ $m: mediaId, $now: Date.now() });
  emit({ type: "aborted", jobId: "", mediaId, roomId: null, progress: 0, downloadedBytes: 0, totalBytes: 0 });
  discardMedia(mediaId); // delete row + files (cascades to its jobs)
  // Keep the id in `aborted` (ids never recur) so any late done/error handler stays a no-op.
  log.info(`aborted media ${mediaId} ("${m.title}")`);
  return true;
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

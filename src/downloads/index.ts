// Download orchestration via in-process WebTorrent. The app owns the torrent lifecycle
// (brief §7.3, §8). NOTE: WebTorrent must be constructed with { utp: false } or Bun panics on
// uv_timer_init (utp-native uses libuv timers Bun lacks). WebRTC is likewise avoided (no wss trackers).
import WebTorrent from "webtorrent";
import type { Torrent } from "webtorrent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { db } from "../db/index.ts";
import { config } from "../config.ts";
import { logger } from "../logger.ts";
import { ensureActiveDir } from "../storage/index.ts";
import { markAvailable, markFailed, updateSize, getMedia, type Media } from "../media/index.ts";

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

// --- event fan-out (WS layer subscribes) ---
export type DownloadEvent = {
  type: "progress" | "done" | "failed";
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

function pickPlayableFile(torrent: Torrent) {
  const playable = torrent.files.filter((f) => {
    const dot = f.name.lastIndexOf(".");
    return dot !== -1 && PLAYABLE.has(f.name.slice(dot).toLowerCase());
  });
  const pool = playable.length ? playable : torrent.files;
  return pool.reduce((a, b) => (b.length > a.length ? b : a));
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
    const file = pickPlayableFile(torrent);
    const abs = join(path, file.path);
    // Size on disk is the whole torrent (all files were fetched).
    markAvailable(media.id, abs, Number(torrent.length) || 0);
    finishJob.run({ $status: "done", $p: 1, $err: null, $now: Date.now(), $id: jobId });
    log.info(`download done: media ${media.id} → ${file.name}`);
    emit({
      type: "done",
      jobId,
      mediaId: media.id,
      roomId,
      progress: 1,
      downloadedBytes: torrent.length,
      totalBytes: torrent.length,
    });
    // Keep seeding is unnecessary for a private app; free the wire but keep files on disk.
    torrent.destroy();
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

/** On boot, resume interrupted downloads from their stored magnet; fail the un-resumable. */
export function resumeDownloads(): void {
  const resumable = activeMediaWithMagnet.all();
  for (const m of resumable) {
    log.info(`resuming interrupted download for media ${m.id}`);
    startDownload({ media: m, userId: m.imported_by, roomId: null, magnet: m.magnet! });
  }
  // Anything still 'downloading' without a magnet can't be resumed.
  for (const m of anyActiveMedia.all()) {
    if (!m.magnet) markFailed(m.id);
  }
}

export function shutdown(): Promise<void> {
  return new Promise((resolve) => client.destroy(() => resolve()));
}

export { getMedia };

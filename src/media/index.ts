// Media entity: lifecycle (downloading → available → archived / failed), search, transitions.
import { randomUUID } from "node:crypto";
import { db } from "../db/index.ts";
import { logger } from "../logger.ts";
import { moveToArchive, restoreToActive, rebasePath, deleteItemFiles, activeItemDir, archiveItemDir } from "../storage/index.ts";
import { activeUsage, archiveUsage, wouldExceedActive } from "./quota.ts";

const log = logger("media");

export type MediaState = "downloading" | "converting" | "available" | "archived" | "failed";

export type Media = {
  id: string;
  title: string;
  source_type: string;
  external_id: string | null;
  imported_by: string | null;
  state: MediaState;
  file_path: string | null;
  file_size_bytes: number;
  magnet: string | null;
  metadata_json: string | null;
  created_at: number;
  archived_at: number | null;
};

const insertMedia = db.query(
  `INSERT INTO media (id, title, source_type, external_id, imported_by, state, file_path, file_size_bytes, magnet, metadata_json, created_at, archived_at)
   VALUES ($id, $title, $source, $ext, $by, $state, $path, $size, $magnet, $meta, $created, NULL)`,
);
const byId = db.query<Media, [string]>(`SELECT * FROM media WHERE id = ?`);
const setState = db.query(`UPDATE media SET state = ? WHERE id = ?`);
const setAvailable = db.query(
  `UPDATE media SET state = 'available', file_path = ?, file_size_bytes = ? WHERE id = ?`,
);
const setArchived = db.query(
  `UPDATE media SET state = 'archived', file_path = ?, archived_at = ? WHERE id = ?`,
);
const setRestored = db.query(`UPDATE media SET state = 'available', file_path = ?, archived_at = NULL WHERE id = ?`);
const setFailed = db.query(`UPDATE media SET state = 'failed' WHERE id = ?`);
const removeRow = db.query(`DELETE FROM media WHERE id = ?`);

const searchByState = db.query<Media, [string, string]>(
  `SELECT * FROM media WHERE state = ? AND title LIKE ? ORDER BY created_at DESC LIMIT 50`,
);
const listByState = db.query<Media, [string]>(
  `SELECT * FROM media WHERE state = ? ORDER BY created_at DESC LIMIT 50`,
);
const oldestArchivedByUser = db.query<Media, [string]>(
  `SELECT * FROM media WHERE imported_by = ? AND state = 'archived' ORDER BY archived_at ASC`,
);

export class MediaError extends Error {}

export function getMedia(id: string): Media | null {
  return byId.get(id);
}

export function createDownloadingMedia(input: {
  title: string;
  sourceType: string;
  externalId: string | null;
  importedBy: string;
  magnet: string | null;
  metadata?: Record<string, unknown>;
}): Media {
  const id = randomUUID();
  insertMedia.run({
    $id: id,
    $title: input.title,
    $source: input.sourceType,
    $ext: input.externalId,
    $by: input.importedBy,
    $state: "downloading",
    $path: null,
    $size: 0,
    $magnet: input.magnet,
    $meta: input.metadata ? JSON.stringify(input.metadata) : null,
    $created: Date.now(),
  });
  return byId.get(id)!;
}

export function markAvailable(id: string, filePath: string, sizeBytes: number): void {
  setAvailable.run(filePath, sizeBytes, id);
  log.info(`media ${id} available (${sizeBytes} bytes)`);
}

export function markFailed(id: string): void {
  setFailed.run(id);
  log.warn(`media ${id} failed`);
}

export function markConverting(id: string): void {
  setState.run("converting", id);
  log.info(`media ${id} converting`);
}

export function updateTitle(id: string, title: string): void {
  db.query(`UPDATE media SET title = ? WHERE id = ?`).run(title, id);
}

/** Create a sibling media row (state=converting) for another video file from the same download. */
export function createConvertedSibling(parent: Media, title: string): Media {
  const id = randomUUID();
  insertMedia.run({
    $id: id,
    $title: title,
    $source: parent.source_type,
    $ext: parent.external_id,
    $by: parent.imported_by,
    $state: "converting",
    $path: null,
    $size: 0,
    $magnet: null, // already downloaded as part of the parent torrent
    $meta: parent.metadata_json,
    $created: Date.now(),
  });
  return byId.get(id)!;
}

/** Updates the tracked size as a download progresses (so quota reflects reality). */
export function updateSize(id: string, sizeBytes: number): void {
  db.query(`UPDATE media SET file_size_bytes = ? WHERE id = ?`).run(sizeBytes, id);
}

function like(q: string): string {
  return `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
}

/** Section 1: available shared-library matches. Empty query returns recent items. */
export function searchLibrary(q: string): Media[] {
  return q.trim() ? searchByState.all("available", like(q.trim())) : listByState.all("available");
}

/** Section 2: archived matches. */
export function searchArchive(q: string): Media[] {
  return q.trim() ? searchByState.all("archived", like(q.trim())) : listByState.all("archived");
}

const listInProgress = db.query<Media, []>(
  `SELECT * FROM media WHERE state IN ('downloading', 'converting') ORDER BY created_at DESC LIMIT 50`,
);
/** In-progress items — downloading or converting (shown unobtrusively in the room). */
export function listDownloading(): Media[] {
  return listInProgress.all();
}

/** Archive a media item, then purge the owner's oldest archives if over quota (brief §6.3). */
export function archiveMedia(id: string): Media {
  const m = byId.get(id);
  if (!m) throw new MediaError("Media not found");
  if (m.state === "archived") return m;
  if (m.state !== "available") throw new MediaError(`Cannot archive media in state "${m.state}"`);

  moveToArchive(id);
  const newPath = m.file_path ? rebasePath(m.file_path, activeItemDir(id), archiveItemDir(id)) : null;
  setArchived.run(newPath, Date.now(), id);
  log.info(`archived media ${id} ("${m.title}")`);

  if (m.imported_by) purgeOverQuota(m.imported_by);
  return byId.get(id)!;
}

/** Restore an archived item back into the active library (owner active-quota checked). */
export function restoreMedia(id: string): Media {
  const m = byId.get(id);
  if (!m) throw new MediaError("Media not found");
  if (m.state === "available") return m;
  if (m.state !== "archived") throw new MediaError(`Cannot restore media in state "${m.state}"`);
  if (m.imported_by && wouldExceedActive(m.imported_by, m.file_size_bytes)) {
    throw new MediaError("Restoring would exceed the owner's active storage quota");
  }
  restoreToActive(id);
  const newPath = m.file_path ? rebasePath(m.file_path, archiveItemDir(id), activeItemDir(id)) : null;
  setRestored.run(newPath, id);
  log.info(`restored media ${id} ("${m.title}")`);
  return byId.get(id)!;
}

/** Unconditionally remove a media item (row + files) — used when aborting a download/conversion. */
export function discardMedia(id: string): void {
  deleteItemFiles(id);
  removeRow.run(id);
}

/** Permanently delete a media item (row + files). Intended for archived/failed items. */
export function deleteMedia(id: string): Media {
  const m = byId.get(id);
  if (!m) throw new MediaError("Media not found");
  if (m.state === "available") throw new MediaError("Archive an item before deleting it");
  deleteItemFiles(id);
  removeRow.run(id);
  log.info(`deleted media ${id} ("${m.title}")`);
  return m;
}

/** Purge the user's oldest archived items until their archive usage is under quota. Returns count. */
export function purgeOverQuota(userId: string): number {
  const quota = db.query<{ q: number }, [string]>(`SELECT archive_quota_bytes AS q FROM users WHERE id = ?`).get(userId)?.q;
  if (quota == null) return 0;
  let used = archiveUsage(userId);
  if (used <= quota) return 0;

  let purged = 0;
  for (const item of oldestArchivedByUser.all(userId)) {
    if (used <= quota) break;
    deleteItemFiles(item.id);
    removeRow.run(item.id);
    used -= item.file_size_bytes;
    purged++;
    log.info(`purged archived media ${item.id} ("${item.title}", ${item.file_size_bytes} bytes) — over archive quota`);
  }
  return purged;
}

const largestAvailableByUser = db.query<Media, [string]>(
  `SELECT * FROM media WHERE imported_by = ? AND state = 'available' ORDER BY file_size_bytes DESC`,
);
/**
 * Archive the user's largest available items until their active usage is under `quotaBytes` —
 * i.e. the *fewest* files needed to get under. Returns how many were archived.
 */
export function enforceStorageQuota(userId: string, quotaBytes: number): number {
  let archived = 0;
  while (activeUsage(userId) > quotaBytes) {
    const largest = largestAvailableByUser.all(userId)[0];
    if (!largest) break; // only in-flight downloads left; can't archive those
    archiveMedia(largest.id); // moves to archive (and cascades to oldest-first archive purge)
    archived++;
  }
  return archived;
}

export function mediaToJSON(m: Media) {
  return {
    id: m.id,
    title: m.title,
    source: m.source_type,
    externalId: m.external_id,
    importedBy: m.imported_by,
    state: m.state,
    sizeBytes: m.file_size_bytes,
    createdAt: m.created_at,
    archivedAt: m.archived_at,
  };
}

// Filesystem layout + archive moves + oldest-first purge (brief §6, §12).
// Active media: <mediaDir>/<mediaId>/...   Archived: <archiveDir>/<mediaId>/...
import { existsSync, mkdirSync, renameSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

const log = logger("storage");

export function activeItemDir(mediaId: string): string {
  return join(config.mediaDir, mediaId);
}
export function archiveItemDir(mediaId: string): string {
  return join(config.archiveDir, mediaId);
}

export function ensureActiveDir(mediaId: string): string {
  const dir = activeItemDir(mediaId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function move(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(join(to, ".."), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    // Fallback for cross-device moves.
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Moves a media item's files from active to archive storage. Returns the new base dir. */
export function moveToArchive(mediaId: string): string {
  const from = activeItemDir(mediaId);
  const to = archiveItemDir(mediaId);
  move(from, to);
  return to;
}

/** Moves a media item's files back from archive to active storage. Returns the new base dir. */
export function restoreToActive(mediaId: string): string {
  const from = archiveItemDir(mediaId);
  const to = activeItemDir(mediaId);
  move(from, to);
  return to;
}

/** Rewrites an absolute file path from one base media dir to another (active<->archive). */
export function rebasePath(filePath: string, fromBase: string, toBase: string): string {
  if (filePath.startsWith(fromBase)) return toBase + filePath.slice(fromBase.length);
  return filePath;
}

export function deleteItemFiles(mediaId: string): void {
  rmSync(activeItemDir(mediaId), { recursive: true, force: true });
  rmSync(archiveItemDir(mediaId), { recursive: true, force: true });
  log.info(`deleted files for media ${mediaId}`);
}

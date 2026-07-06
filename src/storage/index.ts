// Filesystem layout + archive moves + oldest-first purge (brief §6, §12).
// Active media: <mediaDir>/<mediaId>/...   Archived: <archiveDir>/<mediaId>/...
import { existsSync, mkdirSync, renameSync, rmSync, cpSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

const log = logger("storage");

// The data directory is admin-configurable at runtime; media/archive live under it. New downloads
// go to the current dir — existing files keep their absolute paths (stored per-media), so pointing
// at a new directory doesn't move or break anything already downloaded.
let dataRoot = config.dataDir;

export function currentDataDir(): string {
  return dataRoot;
}
export function setDataRoot(dir: string): void {
  dataRoot = dir;
  mkdirSync(join(dataRoot, "media"), { recursive: true });
  mkdirSync(join(dataRoot, "archive"), { recursive: true });
  log.info(`data directory set to ${dataRoot}`);
}

export function activeItemDir(mediaId: string): string {
  return join(dataRoot, "media", mediaId);
}
export function archiveItemDir(mediaId: string): string {
  return join(dataRoot, "archive", mediaId);
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

/** Move a single file to an absolute destination path (creating parent dirs). */
export function moveFileInto(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch {
    cpSync(src, dest);
    rmSync(src, { force: true });
  }
}

/** Delete everything in a media's active dir except the given file (used after conversion). */
export function keepOnly(mediaId: string, keepBasename: string): void {
  const dir = activeItemDir(mediaId);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry !== keepBasename) rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

export function deleteItemFiles(mediaId: string): void {
  rmSync(activeItemDir(mediaId), { recursive: true, force: true });
  rmSync(archiveItemDir(mediaId), { recursive: true, force: true });
  log.info(`deleted files for media ${mediaId}`);
}

// Central configuration, parsed once from the environment (Bun auto-loads `.env`).
import { resolve, join } from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return raw !== "false" && raw !== "0";
}

const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");

export const config = {
  port: num("PORT", 3000),
  dataDir: DATA_DIR,
  dbPath: join(DATA_DIR, "streamthing.db"),
  mediaDir: join(DATA_DIR, "media"),
  archiveDir: join(DATA_DIR, "archive"),
  sessionTtlMs: 1000 * 60 * 60 * 24 * 30, // 30 days
  defaultStorageQuotaBytes: num("DEFAULT_STORAGE_QUOTA_BYTES", 10 * 1024 ** 3),
  defaultArchiveQuotaBytes: num("DEFAULT_ARCHIVE_QUOTA_BYTES", 20 * 1024 ** 3),
  allowRegistration: bool("ALLOW_REGISTRATION", true),
};

export type Config = typeof config;

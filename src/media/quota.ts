// Per-user byte accounting. Usage is attributed to the importing user (brief §12.2).
import { db } from "../db/index.ts";

// Active usage = bytes for media the user imported that are downloading, converting, or available.
const activeUsageQ = db.query<{ total: number }, [string]>(
  `SELECT COALESCE(SUM(file_size_bytes), 0) AS total FROM media
   WHERE imported_by = ? AND state IN ('downloading', 'converting', 'available')`,
);
// Archive usage = bytes for media the user imported that are archived.
const archiveUsageQ = db.query<{ total: number }, [string]>(
  `SELECT COALESCE(SUM(file_size_bytes), 0) AS total FROM media
   WHERE imported_by = ? AND state = 'archived'`,
);
const userQuotaQ = db.query<{ storage_quota_bytes: number; archive_quota_bytes: number }, [string]>(
  `SELECT storage_quota_bytes, archive_quota_bytes FROM users WHERE id = ?`,
);

export function activeUsage(userId: string): number {
  return activeUsageQ.get(userId)?.total ?? 0;
}
export function archiveUsage(userId: string): number {
  return archiveUsageQ.get(userId)?.total ?? 0;
}

export type QuotaSnapshot = {
  activeUsed: number;
  activeQuota: number;
  archiveUsed: number;
  archiveQuota: number;
};

export function quotaSnapshot(userId: string): QuotaSnapshot {
  const q = userQuotaQ.get(userId);
  return {
    activeUsed: activeUsage(userId),
    activeQuota: q?.storage_quota_bytes ?? 0,
    archiveUsed: archiveUsage(userId),
    archiveQuota: q?.archive_quota_bytes ?? 0,
  };
}

/** Would adding `bytes` to the user's active storage exceed their quota? (brief §12.3 Option A) */
export function wouldExceedActive(userId: string, bytes: number): boolean {
  const q = userQuotaQ.get(userId);
  if (!q) return true;
  return activeUsage(userId) + bytes > q.storage_quota_bytes;
}

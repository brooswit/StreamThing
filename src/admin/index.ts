// Admin operations: per-user quota management + admin flag. Gated by requireAdmin in the HTTP layer.
import { db } from "../db/index.ts";
import { config } from "../config.ts";
import { activeUsage, archiveUsage } from "../media/quota.ts";
import { enforceStorageQuota, purgeOverQuota } from "../media/index.ts";
import { logger } from "../logger.ts";

const log = logger("admin");

export class AdminError extends Error {}

export type AdminUser = {
  id: string;
  username: string;
  isAdmin: boolean;
  storageQuota: number;
  storageUsed: number;
  archiveQuota: number;
  archiveUsed: number;
};

const allUsers = db.query<
  { id: string; username: string; is_admin: number; storage_quota_bytes: number; archive_quota_bytes: number },
  []
>(`SELECT id, username, is_admin, storage_quota_bytes, archive_quota_bytes FROM users ORDER BY created_at`);
const userRow = db.query<{ id: string; username: string; is_admin: number }, [string]>(
  `SELECT id, username, is_admin FROM users WHERE id = ?`,
);
const adminCount = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM users WHERE is_admin = 1`);
const setStorageQuota = db.query(`UPDATE users SET storage_quota_bytes = ? WHERE id = ?`);
const setArchiveQuota = db.query(`UPDATE users SET archive_quota_bytes = ? WHERE id = ?`);
const setAdminFlag = db.query(`UPDATE users SET is_admin = ? WHERE id = ?`);
const deleteUserRow = db.query(`DELETE FROM users WHERE id = ?`);

export function listUsers(): AdminUser[] {
  return allUsers.all().map((u) => ({
    id: u.id,
    username: u.username,
    isAdmin: !!u.is_admin,
    storageQuota: u.storage_quota_bytes,
    storageUsed: activeUsage(u.id),
    archiveQuota: u.archive_quota_bytes,
    archiveUsed: archiveUsage(u.id),
  }));
}

export type UserUpdate = { storageQuotaBytes?: number; archiveQuotaBytes?: number; isAdmin?: boolean };

/** Apply admin edits to a user, enforcing the new quotas. Returns what was archived/purged. */
export function updateUser(id: string, patch: UserUpdate): { archived: number; purged: number } {
  const u = userRow.get(id);
  if (!u) throw new AdminError("User not found");
  let archived = 0;
  let purged = 0;

  if (patch.storageQuotaBytes != null) {
    const q = Math.floor(patch.storageQuotaBytes);
    if (!Number.isFinite(q) || q < 0) throw new AdminError("Storage quota must be a non-negative number");
    setStorageQuota.run(q, id);
    archived = enforceStorageQuota(id, q); // archive largest-first (fewest files) to get under
  }

  if (patch.archiveQuotaBytes != null) {
    const q = Math.floor(patch.archiveQuotaBytes);
    if (!Number.isFinite(q) || q < 0) throw new AdminError("Archive quota must be a non-negative number");
    setArchiveQuota.run(q, id);
    purged = purgeOverQuota(id); // delete oldest-first to get under
  }

  if (patch.isAdmin != null) {
    if (!patch.isAdmin && u.is_admin && (adminCount.get()?.n ?? 0) <= 1) {
      throw new AdminError("Can't remove admin from the last administrator");
    }
    setAdminFlag.run(patch.isAdmin ? 1 : 0, id);
  }

  log.info(`updated user ${u.username} (archived ${archived}, purged ${purged})`);
  return { archived, purged };
}

/**
 * Delete a user account. Their media stays in the shared library (imported_by becomes NULL via the
 * schema's ON DELETE SET NULL), so shared content isn't lost — it's just no longer attributed.
 */
export function deleteUser(id: string, actingUserId: string): void {
  const u = userRow.get(id);
  if (!u) throw new AdminError("User not found");
  if (id === actingUserId) throw new AdminError("You can't delete your own account");
  if (u.is_admin && (adminCount.get()?.n ?? 0) <= 1) throw new AdminError("Can't delete the last admin");
  deleteUserRow.run(id);
  log.info(`deleted user ${u.username}`);
}

/** Reset a user's quotas to the configured defaults (enforcing them). */
export function resetUser(id: string): { archived: number; purged: number } {
  return updateUser(id, {
    storageQuotaBytes: config.defaultStorageQuotaBytes,
    archiveQuotaBytes: config.defaultArchiveQuotaBytes,
  });
}

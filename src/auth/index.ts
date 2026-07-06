// Auth: account creation, login, opaque server-side sessions, cookie helpers.
// Private app — no OAuth/JWT. Session tokens are random and validated against the DB.
import { randomUUID, randomBytes } from "node:crypto";
import { db } from "../db/index.ts";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

const log = logger("auth");
const COOKIE = "st_session";

export type User = {
  id: string;
  username: string;
  storage_quota_bytes: number;
  archive_quota_bytes: number;
  created_at: number;
};

type UserRow = User & { password_hash: string };

// --- prepared statements ---
const insertUser = db.query(
  `INSERT INTO users (id, username, password_hash, storage_quota_bytes, archive_quota_bytes, created_at)
   VALUES ($id, $username, $hash, $storage, $archive, $created)`,
);
const userByName = db.query<UserRow, [string]>(`SELECT * FROM users WHERE username = ?`);
const userById = db.query<UserRow, [string]>(`SELECT * FROM users WHERE id = ?`);
const insertSession = db.query(
  `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
);
const sessionByToken = db.query<{ user_id: string; expires_at: number }, [string]>(
  `SELECT user_id, expires_at FROM sessions WHERE token = ?`,
);
const deleteSession = db.query(`DELETE FROM sessions WHERE token = ?`);

function publicUser(row: UserRow): User {
  const { password_hash, ...rest } = row;
  return rest;
}

export class AuthError extends Error {}

export async function register(username: string, password: string): Promise<User> {
  username = username.trim();
  if (!config.allowRegistration) throw new AuthError("Registration is disabled");
  if (username.length < 3 || username.length > 32) throw new AuthError("Username must be 3–32 characters");
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) throw new AuthError("Username has invalid characters");
  if (password.length < 6) throw new AuthError("Password must be at least 6 characters");
  if (userByName.get(username)) throw new AuthError("Username is taken");

  const hash = await Bun.password.hash(password); // argon2id
  const user = {
    id: randomUUID(),
    username,
    storage_quota_bytes: config.defaultStorageQuotaBytes,
    archive_quota_bytes: config.defaultArchiveQuotaBytes,
    created_at: Date.now(),
  };
  insertUser.run({
    $id: user.id,
    $username: user.username,
    $hash: hash,
    $storage: user.storage_quota_bytes,
    $archive: user.archive_quota_bytes,
    $created: user.created_at,
  });
  log.info(`registered user ${username}`);
  return user;
}

export async function login(username: string, password: string): Promise<User> {
  const row = userByName.get(username.trim());
  if (!row || !(await Bun.password.verify(password, row.password_hash))) {
    log.warn(`failed login for "${username}"`);
    throw new AuthError("Invalid username or password");
  }
  return publicUser(row);
}

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  insertSession.run(token, userId, now, now + config.sessionTtlMs);
  return token;
}

export function destroySession(token: string): void {
  deleteSession.run(token);
}

export function userFromToken(token: string | null): User | null {
  if (!token) return null;
  const sess = sessionByToken.get(token);
  if (!sess) return null;
  if (sess.expires_at < Date.now()) {
    deleteSession.run(token);
    return null;
  }
  const row = userById.get(sess.user_id);
  return row ? publicUser(row) : null;
}

// --- cookie helpers ---
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie");
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string): string {
  const maxAge = Math.floor(config.sessionTtlMs / 1000);
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function tokenFromRequest(req: Request): string | null {
  return parseCookies(req)[COOKIE] ?? null;
}

/** Returns the authenticated user for a request, or null. */
export function userFromRequest(req: Request): User | null {
  return userFromToken(tokenFromRequest(req));
}

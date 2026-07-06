// Idempotent schema. Runs on every boot; safe to re-run (CREATE TABLE IF NOT EXISTS).
import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                   TEXT PRIMARY KEY,
      username             TEXT NOT NULL UNIQUE,
      password_hash        TEXT NOT NULL,
      storage_quota_bytes  INTEGER NOT NULL,
      archive_quota_bytes  INTEGER NOT NULL,
      is_admin             INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS rooms (
      slug        TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS room_state (
      room_id           TEXT PRIMARY KEY REFERENCES rooms(slug) ON DELETE CASCADE,
      media_id          TEXT REFERENCES media(id) ON DELETE SET NULL,
      status            TEXT NOT NULL DEFAULT 'idle',
      position_seconds  REAL NOT NULL DEFAULT 0,
      updated_at        INTEGER NOT NULL,
      updated_by        TEXT
    );

    CREATE TABLE IF NOT EXISTS media (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      source_type      TEXT NOT NULL,
      external_id      TEXT,
      imported_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
      state            TEXT NOT NULL,           -- downloading | available | archived | failed
      file_path        TEXT,
      file_size_bytes  INTEGER NOT NULL DEFAULT 0,
      magnet           TEXT,
      metadata_json    TEXT,
      created_at       INTEGER NOT NULL,
      archived_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_media_state ON media(state);
    CREATE INDEX IF NOT EXISTS idx_media_owner ON media(imported_by);

    CREATE TABLE IF NOT EXISTS download_jobs (
      id                TEXT PRIMARY KEY,
      media_id          TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
      room_id           TEXT,
      source            TEXT NOT NULL,
      external_id       TEXT,
      status            TEXT NOT NULL,          -- active | done | failed
      progress          REAL NOT NULL DEFAULT 0,
      downloaded_bytes  INTEGER NOT NULL DEFAULT 0,
      total_bytes       INTEGER NOT NULL DEFAULT 0,
      error             TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON download_jobs(status);

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      room_id     TEXT NOT NULL,
      user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
      username    TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);

    CREATE TABLE IF NOT EXISTS friendships (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id)
    );
    CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );
  `);

  // Additive column migrations for databases created before the column existed.
  addColumnIfMissing(db, "users", "is_admin", "INTEGER NOT NULL DEFAULT 0");
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

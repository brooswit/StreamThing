// Tiny persisted key/value settings (admin-tunable, stored in the DB).
import { db } from "../db/index.ts";

const getQ = db.query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`);
const setQ = db.query(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`);

export function getSetting(key: string): string | null {
  return getQ.get(key)?.value ?? null;
}
export function setSetting(key: string, value: string): void {
  setQ.run(key, value, value);
}

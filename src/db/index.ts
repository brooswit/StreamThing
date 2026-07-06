// Opens the single SQLite database and runs migrations.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { config } from "../config.ts";
import { migrate } from "./schema.ts";

// Ensure data directories exist before opening the DB / writing media.
for (const dir of [config.dataDir, config.mediaDir, config.archiveDir]) {
  mkdirSync(dir, { recursive: true });
}

export const db = new Database(config.dbPath, { create: true });
migrate(db);

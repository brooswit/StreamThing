// The Pirate Bay source adapter. Based on the user's ThePirateBayJS (apibay.org), extended to
// preserve seeders/size/info_hash that the original discards — the room UI needs them.
import type { MediaSourceAdapter, SearchResult } from "../types.ts";
import { createMagnetLink } from "./magnet.ts";
import { logger } from "../../logger.ts";

const log = logger("source:tpb");

// Raw apibay.org result shape (all fields are strings).
type ApibayResult = {
  id: string;
  name: string;
  info_hash: string;
  seeders: string;
  leechers: string;
  size: string;
  num_files: string;
  category: string;
  imdb: string;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

// apibay returns this sentinel row when there are no matches.
const NO_RESULTS_HASH = "0000000000000000000000000000000000000000";

export const tpbSource: MediaSourceAdapter = {
  id: "tpb",
  label: "The Pirate Bay",

  async search(query: string): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(q)}`;
    let raw: ApibayResult[];
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = (await res.json()) as ApibayResult[];
    } catch (err) {
      log.error(`search failed for "${q}"`, (err as Error).message);
      return [];
    }

    return raw
      .filter((t) => t.info_hash && t.info_hash !== NO_RESULTS_HASH && t.id !== "0" && t.name)
      .map((t) => ({
        source: "tpb",
        externalId: t.info_hash,
        title: t.name,
        subtitle: `${t.seeders} seeders · ${formatSize(Number(t.size))}`,
        sizeBytes: Number(t.size) || undefined,
        seeders: Number(t.seeders) || 0,
        magnet: createMagnetLink(t.info_hash, t.name),
        metadata: { imdb: t.imdb || undefined, numFiles: Number(t.num_files) || undefined, category: t.category },
      }))
      // Most seeders first — most likely to actually download.
      .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
  },
};

function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

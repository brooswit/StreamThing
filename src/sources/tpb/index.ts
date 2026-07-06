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

// apibay.org is TPB's official — and, per testing ~50 mirror domains, the only — JSON API host.
// Every public "mirror"/"proxy" is just an HTML frontend that calls apibay from the browser, so
// there's nothing to fail over to. apibay is often slow/flaky, so we simply retry it.
const API_URL = "https://apibay.org/q.php";
// apibay is reliably slow (~20s responses observed), so allow generous time. The search UI shows
// local results instantly and loads sources separately, so a slow source is fine.
const TIMEOUT_MS = Number(process.env.TPB_TIMEOUT_MS) || 30000;
const ATTEMPTS = 2;

async function fetchApibay(query: string): Promise<ApibayResult[]> {
  const url = `${API_URL}?q=${encodeURIComponent(query)}`;
  let lastError = "request failed";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("unexpected response");
      return data as ApibayResult[];
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError";
      lastError = timedOut ? "timed out" : (err as Error).message;
      log.warn(`apibay attempt ${attempt}/${ATTEMPTS} failed: ${lastError}`);
      // A timeout means apibay is slow/down — a second attempt would just wait another full timeout.
      // Only retry fast failures (connection reset, transient 5xx, etc.).
      if (timedOut) break;
    }
  }
  throw new Error(lastError);
}

export const tpbSource: MediaSourceAdapter = {
  id: "tpb",
  label: "The Pirate Bay",

  async search(query: string): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    // Throws on total failure so the registry marks this source errored (vs. silently "no results").
    const raw = await fetchApibay(q);

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

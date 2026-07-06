// Source registry — register adapters here; the rest of the app is source-agnostic.
import type { MediaSourceAdapter, SearchResult } from "./types.ts";
import { tpbSource } from "./tpb/index.ts";
import { logger } from "../logger.ts";

const log = logger("sources");

const adapters = new Map<string, MediaSourceAdapter>();

export function register(adapter: MediaSourceAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): MediaSourceAdapter | undefined {
  return adapters.get(id);
}

export function listAdapters(): MediaSourceAdapter[] {
  return [...adapters.values()];
}

/** Search all registered external sources concurrently. Returns results grouped by source id. */
export async function searchAllSources(query: string): Promise<Record<string, SearchResult[]>> {
  const entries = await Promise.all(
    listAdapters().map(async (a) => {
      try {
        return [a.id, await a.search(query)] as const;
      } catch (err) {
        log.error(`adapter "${a.id}" search error`, (err as Error).message);
        return [a.id, [] as SearchResult[]] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

// Register built-in sources.
register(tpbSource);

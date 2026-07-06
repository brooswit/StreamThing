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

export type SourceGroup = {
  id: string;
  label: string;
  ok: boolean;
  results: SearchResult[];
  error?: string;
};

/** Search all registered external sources concurrently, reporting per-source success/failure. */
export async function searchAllSources(query: string): Promise<SourceGroup[]> {
  return Promise.all(
    listAdapters().map(async (a): Promise<SourceGroup> => {
      try {
        return { id: a.id, label: a.label, ok: true, results: await a.search(query) };
      } catch (err) {
        const error = (err as Error).message;
        log.error(`adapter "${a.id}" search error`, error);
        return { id: a.id, label: a.label, ok: false, results: [], error };
      }
    }),
  );
}

// Register built-in sources.
register(tpbSource);

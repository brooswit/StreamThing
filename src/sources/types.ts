// Stable internal contract for media source adapters (brief §17).
// The room/search UI never contains source-specific logic — adapters normalize to these shapes.

export type MediaSourceId = string;

export type SearchResult = {
  source: MediaSourceId;
  externalId: string;
  title: string;
  subtitle?: string;
  sizeBytes?: number;
  seeders?: number;
  // A directly-usable acquisition handle (e.g. magnet URI). The downloads layer consumes this.
  magnet?: string;
  metadata?: Record<string, unknown>;
};

export interface MediaSourceAdapter {
  id: MediaSourceId;
  label: string;
  search(query: string): Promise<SearchResult[]>;
}

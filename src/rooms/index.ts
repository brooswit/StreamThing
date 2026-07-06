// Rooms: slug generation, optimistic creation, and canonical playback state.
// Server is authoritative for playback (brief §9.3). State is persisted and cached.
import { db } from "../db/index.ts";

export type PlaybackStatus = "idle" | "playing" | "paused";

export type RoomState = {
  roomId: string;
  mediaId: string | null;
  status: PlaybackStatus;
  positionSeconds: number;
  updatedAt: number;
  updatedByUserId: string | null;
};

const ADJECTIVES = ["amber", "brisk", "calm", "dusk", "ember", "fern", "glow", "haze", "iris", "jade", "koi", "lush", "moss", "nova", "opal", "pine", "quill", "rune", "sage", "teal", "umber", "vale", "wisp", "yarn", "zephyr"];
const NOUNS = ["otter", "falcon", "cedar", "harbor", "meadow", "canyon", "lantern", "willow", "cinder", "pebble", "thistle", "marble", "raven", "cove", "birch", "summit", "delta", "grove", "onyx", "reef", "spruce", "tide", "vireo", "wren"];

const upsertState = db.query(
  `INSERT INTO room_state (room_id, media_id, status, position_seconds, updated_at, updated_by)
   VALUES ($room, $media, $status, $pos, $updated, $by)
   ON CONFLICT(room_id) DO UPDATE SET
     media_id=$media, status=$status, position_seconds=$pos, updated_at=$updated, updated_by=$by`,
);
const selectState = db.query<
  { media_id: string | null; status: PlaybackStatus; position_seconds: number; updated_at: number; updated_by: string | null },
  [string]
>(`SELECT media_id, status, position_seconds, updated_at, updated_by FROM room_state WHERE room_id = ?`);
const insertRoom = db.query(
  `INSERT INTO rooms (slug, created_at, created_by) VALUES (?, ?, ?) ON CONFLICT(slug) DO NOTHING`,
);
const roomExists = db.query<{ slug: string }, [string]>(`SELECT slug FROM rooms WHERE slug = ?`);

// In-memory cache of the current state per room (rebuilt lazily from the DB).
const cache = new Map<string, RoomState>();

function pick<T>(arr: T[], n: number): T {
  return arr[n % arr.length]!;
}

/** Generates a random, human-friendly room slug (no collision pre-check — brief §3.2). */
export function generateSlug(): string {
  const r = crypto.getRandomValues(new Uint32Array(3));
  return `${pick(ADJECTIVES, r[0]!)}-${pick(NOUNS, r[1]!)}-${(r[2]! % 9000) + 1000}`;
}

/** Creates the room if absent (optimistic). Collisions simply reuse the existing room. */
export function ensureRoom(slug: string, createdBy: string | null = null): void {
  insertRoom.run(slug, Date.now(), createdBy);
}

export function roomIsKnown(slug: string): boolean {
  return roomExists.get(slug) != null || cache.has(slug);
}

export function getRoomState(roomId: string): RoomState {
  const cached = cache.get(roomId);
  if (cached) return cached;
  const row = selectState.get(roomId);
  const state: RoomState = row
    ? {
        roomId,
        mediaId: row.media_id,
        status: row.status,
        positionSeconds: row.position_seconds,
        updatedAt: row.updated_at,
        updatedByUserId: row.updated_by,
      }
    : { roomId, mediaId: null, status: "idle", positionSeconds: 0, updatedAt: Date.now(), updatedByUserId: null };
  cache.set(roomId, state);
  return state;
}

export function setRoomState(state: RoomState): void {
  cache.set(state.roomId, state);
  upsertState.run({
    $room: state.roomId,
    $media: state.mediaId,
    $status: state.status,
    $pos: state.positionSeconds,
    $updated: state.updatedAt,
    $by: state.updatedByUserId,
  });
}

export type PlaybackCommand =
  | { type: "LOAD_MEDIA"; mediaId: string }
  | { type: "PLAY"; positionSeconds?: number }
  | { type: "PAUSE"; positionSeconds?: number }
  | { type: "SEEK"; positionSeconds: number };

/** Applies a client command to the canonical room state and returns the new state. */
export function applyCommand(roomId: string, userId: string | null, cmd: PlaybackCommand): RoomState {
  const cur = getRoomState(roomId);
  const now = Date.now();
  const next: RoomState = { ...cur, roomId, updatedAt: now, updatedByUserId: userId };

  switch (cmd.type) {
    case "LOAD_MEDIA":
      next.mediaId = cmd.mediaId;
      next.positionSeconds = 0;
      next.status = "playing";
      break;
    case "PLAY":
      if (cmd.positionSeconds != null) next.positionSeconds = cmd.positionSeconds;
      next.status = "playing";
      break;
    case "PAUSE":
      if (cmd.positionSeconds != null) next.positionSeconds = cmd.positionSeconds;
      next.status = "paused";
      break;
    case "SEEK":
      next.positionSeconds = cmd.positionSeconds;
      break;
  }
  setRoomState(next);
  return next;
}

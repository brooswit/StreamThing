// WebSocket layer: room playback sync + chat + live download feed (brief §9, §10).
// Auth happens at upgrade time via the session cookie; the room is taken from ?room=<slug>.
import type { Server, ServerWebSocket } from "bun";
import { userFromRequest } from "../auth/index.ts";
import { ensureRoom, getRoomState, applyCommand, type PlaybackCommand } from "../rooms/index.ts";
import { addMessage, messageToJSON, recentMessages } from "../chat/index.ts";
import { getMedia } from "../media/index.ts";
import { onDownloadEvent } from "../downloads/index.ts";
import { logger } from "../logger.ts";

const log = logger("ws");

export type WSData = { userId: string; username: string; roomId: string };

const roomTopic = (slug: string) => `room:${slug}`;
// Download/convert progress is broadcast globally (the downloads strip shows all in-progress items,
// not just this room's) — this also covers boot-recovery jobs, which have no originating room.
const DL_TOPIC = "downloads";

// Track sockets per room for presence counts.
const presence = new Map<string, Set<ServerWebSocket<WSData>>>();

let server: Server | null = null;
export function setServer(s: Server): void {
  server = s;
}

function publish(topic: string, payload: unknown): void {
  server?.publish(topic, JSON.stringify(payload));
}

function stateMessage(roomId: string) {
  return { t: "state", state: getRoomState(roomId) };
}

function presenceCount(roomId: string): number {
  return presence.get(roomId)?.size ?? 0;
}

function broadcastPresence(roomId: string): void {
  publish(roomTopic(roomId), { t: "presence", count: presenceCount(roomId) });
}

/** Attempt to upgrade an HTTP request to a room WebSocket. Returns a Response on failure. */
export function upgrade(req: Request, srv: Server): Response | undefined {
  const user = userFromRequest(req);
  if (!user) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const roomId = url.searchParams.get("room");
  if (!roomId) return new Response("Missing room", { status: 400 });

  const ok = srv.upgrade<WSData>(req, { data: { userId: user.id, username: user.username, roomId } });
  if (!ok) return new Response("Upgrade failed", { status: 500 });
  return undefined; // upgraded — Bun takes over the socket
}

export const websocket = {
  open(ws: ServerWebSocket<WSData>) {
    const { roomId, userId, username } = ws.data;
    ensureRoom(roomId, userId);
    ws.subscribe(roomTopic(roomId));
    ws.subscribe(DL_TOPIC);

    let set = presence.get(roomId);
    if (!set) presence.set(roomId, (set = new Set()));
    set.add(ws);

    // Prime the newcomer with current state + recent chat, then update everyone's presence.
    ws.send(JSON.stringify(stateMessage(roomId)));
    ws.send(JSON.stringify({ t: "chat_history", messages: recentMessages(roomId).map(messageToJSON) }));
    broadcastPresence(roomId);
    log.info(`${username} joined room ${roomId} (${presenceCount(roomId)} present)`);
  },

  message(ws: ServerWebSocket<WSData>, raw: string | Buffer) {
    const { roomId, userId, username } = ws.data;
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }

    switch (msg?.t) {
      case "cmd": {
        const cmd = msg.cmd as PlaybackCommand | undefined;
        if (!cmd || !["LOAD_MEDIA", "PLAY", "PAUSE", "SEEK"].includes(cmd.type)) return;
        if (cmd.type === "LOAD_MEDIA") {
          const media = getMedia(cmd.mediaId);
          if (!media || media.state !== "available") {
            ws.send(JSON.stringify({ t: "error", message: "That media isn't available to play." }));
            return;
          }
        }
        const state = applyCommand(roomId, userId, cmd);
        publish(roomTopic(roomId), { t: "state", state });
        log.info(`room ${roomId}: ${cmd.type} by ${username}`);
        break;
      }
      case "chat": {
        const body = String(msg.body ?? "").trim();
        if (!body) return;
        const saved = addMessage(roomId, userId, username, body);
        publish(roomTopic(roomId), { t: "chat", msg: messageToJSON(saved) });
        break;
      }
      case "ping":
        ws.send(JSON.stringify({ t: "pong" }));
        break;
    }
  },

  close(ws: ServerWebSocket<WSData>) {
    const { roomId, username } = ws.data;
    const set = presence.get(roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) presence.delete(roomId);
    }
    broadcastPresence(roomId);
    log.info(`${username} left room ${roomId} (${presenceCount(roomId)} present)`);
  },
};

// Bridge download/convert progress into the global downloads feed (all connected clients).
onDownloadEvent((ev) => {
  publish(DL_TOPIC, { t: "download", ev });
});

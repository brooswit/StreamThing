// Minimal in-app room chat (brief §10, Path A): persist + expose recent messages.
// Broadcast is handled by the WS layer.
import { randomUUID } from "node:crypto";
import { db } from "../db/index.ts";

export type ChatMessage = {
  id: string;
  room_id: string;
  user_id: string | null;
  username: string;
  body: string;
  created_at: number;
};

const insertMsg = db.query(
  `INSERT INTO messages (id, room_id, user_id, username, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
);
const recentMsgs = db.query<ChatMessage, [string, number]>(
  `SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`,
);

export function addMessage(roomId: string, userId: string | null, username: string, body: string): ChatMessage {
  const msg: ChatMessage = {
    id: randomUUID(),
    room_id: roomId,
    user_id: userId,
    username,
    body: body.slice(0, 2000),
    created_at: Date.now(),
  };
  insertMsg.run(msg.id, msg.room_id, msg.user_id, msg.username, msg.body, msg.created_at);
  return msg;
}

/** Most recent messages for a room, returned oldest-first for display. */
export function recentMessages(roomId: string, limit = 50): ChatMessage[] {
  return recentMsgs.all(roomId, limit).reverse();
}

export function messageToJSON(m: ChatMessage) {
  return { id: m.id, roomId: m.room_id, username: m.username, body: m.body, createdAt: m.created_at };
}

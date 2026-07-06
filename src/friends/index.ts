// Friends: mutual relationships between users. Adding a friend is immediate and bidirectional
// (a trusted-household model, no request/accept flow). Used to scope the Library to you + friends.
import { db } from "../db/index.ts";
import { logger } from "../logger.ts";

const log = logger("friends");

export class FriendError extends Error {}

const userByName = db.query<{ id: string; username: string }, [string]>(
  `SELECT id, username FROM users WHERE username = ?`,
);
const insertFriend = db.query(
  `INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)`,
);
const deleteFriend = db.query(`DELETE FROM friendships WHERE user_id = ? AND friend_id = ?`);
const friendsOf = db.query<{ id: string; username: string }, [string]>(
  `SELECT u.id, u.username FROM friendships f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY u.username`,
);
const friendIdsQ = db.query<{ friend_id: string }, [string]>(
  `SELECT friend_id FROM friendships WHERE user_id = ?`,
);

export function listFriends(userId: string): { id: string; username: string }[] {
  return friendsOf.all(userId);
}

/** IDs whose media a user may see in their Library: themselves + their friends. */
export function libraryOwnerIds(userId: string): string[] {
  return [userId, ...friendIdsQ.all(userId).map((r) => r.friend_id)];
}

export function addFriend(userId: string, friendUsername: string): { id: string; username: string } {
  const friend = userByName.get(friendUsername.trim());
  if (!friend) throw new FriendError("No user with that username");
  if (friend.id === userId) throw new FriendError("You can't add yourself");
  const now = Date.now();
  insertFriend.run(userId, friend.id, now);
  insertFriend.run(friend.id, userId, now); // mutual
  log.info(`friendship added between ${userId} and ${friend.username}`);
  return friend;
}

export function removeFriend(userId: string, friendId: string): void {
  deleteFriend.run(userId, friendId);
  deleteFriend.run(friendId, userId); // mutual
  log.info(`friendship removed between ${userId} and ${friendId}`);
}

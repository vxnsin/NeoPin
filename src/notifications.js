import { getDb } from "./db.js";

const LIMIT = 50;

export function addNotification(userId, type, data, at = new Date()) {
  getDb()
    .prepare("INSERT INTO notifications (user_id, type, data, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, type, JSON.stringify(data), at.toISOString());
}

// The newest ones of the account, own only.
export function notificationsFor(userId) {
  return getDb()
    .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, LIMIT)
    .map((r) => ({ id: r.id, type: r.type, createdAt: r.created_at, readAt: r.read_at, data: JSON.parse(r.data) }));
}

// Without ids everything of the account counts as read.
export function markRead(userId, ids) {
  const db = getDb();
  const stamp = new Date().toISOString();
  if (!ids) {
    db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(stamp, userId);
    return;
  }
  const update = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL");
  for (const id of ids) update.run(stamp, id, userId);
}

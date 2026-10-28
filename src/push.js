import { getDb } from "./db.js";

export const PUSH_PLATFORMS = ["android", "ios"];

const toToken = (row) => ({ userId: row.user_id, deviceId: row.device_id, token: row.token, platform: row.platform });

export function setPushToken(userId, deviceId, token, platform) {
  const db = getDb();
  db.prepare(
    `INSERT INTO push_tokens (user_id, device_id, token, platform, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, device_id) DO UPDATE SET token = excluded.token, platform = excluded.platform, updated_at = excluded.updated_at`
  ).run(userId, deviceId, token, platform, new Date().toISOString());
  // A token belongs to one installation: when it moved to another account, the old row is stale.
  db.prepare("DELETE FROM push_tokens WHERE token = ? AND NOT (user_id = ? AND device_id = ?)").run(token, userId, deviceId);
}

export function deletePushToken(userId, deviceId) {
  getDb().prepare("DELETE FROM push_tokens WHERE user_id = ? AND device_id = ?").run(userId, deviceId);
}

export function pushTokenOf(userId, deviceId) {
  const row = getDb().prepare("SELECT * FROM push_tokens WHERE user_id = ? AND device_id = ?").get(userId, deviceId);
  return row ? toToken(row) : null;
}

export function pushTokensOf(userId) {
  return getDb().prepare("SELECT * FROM push_tokens WHERE user_id = ? ORDER BY device_id").all(userId).map(toToken);
}

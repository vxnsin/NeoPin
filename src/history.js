import { config } from "./config.js";
import { getDb } from "./db.js";

// Stored fixes are thinned out: a new one only when the device moved or a while has passed.
// On the move a fix every few seconds is kept, so a bus ride keeps its curves.
const MIN_GAP_MS = 5_000;
const MIN_MOVE_M = 15;
const HEARTBEAT_MS = 5 * 60_000;
// Fixes less exact than this are noise from inside buildings or a cold GPS.
export const MAX_ACCURACY_M = 100;

const last = new Map();

export function distanceM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ts is when the GPS took the fix, so fixes sent later (after a dead spot) land at
// the right time. Those older than the newest stored one go in as they are, without
// disturbing the thinning of the live ones.
export function recordPosition(userId, deviceId, lat, lon, ts = Date.now(), { accuracy = null, speed = null } = {}) {
  if (accuracy !== null && accuracy > MAX_ACCURACY_M) return false;
  const key = `${userId}:${deviceId}`;
  const prev = last.get(key);
  const backfill = prev && ts <= prev.ts;
  if (prev && !backfill) {
    const gap = ts - prev.ts;
    const moved = distanceM(prev.lat, prev.lon, lat, lon);
    if (gap < MIN_GAP_MS) return false;
    if (gap < HEARTBEAT_MS && moved < MIN_MOVE_M) return false;
  }
  getDb()
    .prepare("INSERT INTO positions (user_id, device_id, ts, lat, lon, accuracy, speed) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(userId, deviceId, ts, lat, lon, accuracy, speed);
  if (!backfill) last.set(key, { ts, lat, lon });
  return true;
}

export function positionsBetween(userId, deviceId, from, to) {
  return getDb()
    .prepare(
      "SELECT ts, lat, lon, accuracy, speed FROM positions WHERE user_id = ? AND device_id = ? AND ts >= ? AND ts < ? ORDER BY ts"
    )
    .all(userId, deviceId, from, to);
}

export function lastPosition(userId, deviceId) {
  return (
    getDb()
      .prepare("SELECT ts, lat, lon FROM positions WHERE user_id = ? AND device_id = ? ORDER BY ts DESC LIMIT 1")
      .get(userId, deviceId) ?? null
  );
}

// The last charge a device reported, so it is still there after the device went offline
// or the server restarted. One row per device, overwritten each time.
export function recordBattery(userId, deviceId, level, charging, updatedAt = new Date().toISOString()) {
  getDb()
    .prepare(
      `INSERT INTO device_battery (user_id, device_id, level, charging, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, device_id) DO UPDATE SET level = excluded.level, charging = excluded.charging, updated_at = excluded.updated_at`
    )
    .run(userId, deviceId, level, charging ? 1 : 0, updatedAt);
}

export function lastBattery(userId, deviceId) {
  const row = getDb()
    .prepare("SELECT level, charging, updated_at FROM device_battery WHERE user_id = ? AND device_id = ?")
    .get(userId, deviceId);
  return row ? { level: row.level, charging: row.charging === 1, updatedAt: row.updated_at } : null;
}

export function forgetBattery(userId, deviceId) {
  getDb().prepare("DELETE FROM device_battery WHERE user_id = ? AND device_id = ?").run(userId, deviceId);
}

// Local calendar days that have any data, newest first.
export function daysWithData(userId, deviceId, tzOffsetMin, limit = 120) {
  const shiftSeconds = Math.round((-tzOffsetMin * 60_000) / 1000);
  return getDb()
    .prepare(
      `SELECT DISTINCT date(ts / 1000 + ?, 'unixepoch') AS day FROM positions
       WHERE user_id = ? AND device_id = ? ORDER BY day DESC LIMIT ?`
    )
    .all(shiftSeconds, userId, deviceId, limit)
    .map((r) => r.day);
}

export function pruneHistory(now = Date.now()) {
  const cutoff = now - config.historyDays * 86_400_000;
  return Number(getDb().prepare("DELETE FROM positions WHERE ts < ?").run(cutoff).changes);
}

export function resetHistoryState() {
  last.clear();
}

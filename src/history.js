import { config } from "./config.js";
import { getDb } from "./db.js";

// Stored fixes are thinned out: a new one only when the device moved or a while has passed.
const MIN_GAP_MS = 15_000;
const MIN_MOVE_M = 15;
const HEARTBEAT_MS = 5 * 60_000;

const last = new Map();

export function distanceM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function recordPosition(userId, deviceId, lat, lon, ts = Date.now()) {
  const key = `${userId}:${deviceId}`;
  const prev = last.get(key);
  if (prev) {
    const gap = ts - prev.ts;
    if (gap < MIN_GAP_MS) return false;
    if (gap < HEARTBEAT_MS && distanceM(prev.lat, prev.lon, lat, lon) < MIN_MOVE_M) return false;
  }
  getDb().prepare("INSERT INTO positions (user_id, device_id, ts, lat, lon) VALUES (?, ?, ?, ?, ?)").run(userId, deviceId, ts, lat, lon);
  last.set(key, { ts, lat, lon });
  return true;
}

export function positionsBetween(userId, deviceId, from, to) {
  return getDb()
    .prepare("SELECT ts, lat, lon FROM positions WHERE user_id = ? AND device_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
    .all(userId, deviceId, from, to);
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

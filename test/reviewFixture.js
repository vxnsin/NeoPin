import { getDb } from "../src/db.js";
import { dayBounds } from "../src/review.js";

// A day of fixes for the review tests: the night at home, a walk of about 1.5 km to work, the
// day there, a drive back. Stored straight into the table, past the thinning of recordPosition.
export const HOME = { lat: 52.5, lon: 13.4 };
export const WORK = { lat: 52.5135, lon: 13.4 };

const lerp = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });

export function dayFixes(from, { dense = false } = {}) {
  const fixes = [];
  const still = (at, start, end, every = 5 * 60_000) => {
    for (let ts = start; ts < end; ts += every) fixes.push({ ...at, ts });
  };
  const move = (a, b, start, ms, every) => {
    for (let ts = start, n = Math.round(ms / every); ts <= start + ms; ts += every) {
      fixes.push({ ...lerp(a, b, (ts - start) / (n * every)), ts });
    }
  };
  const h = (hours) => from + hours * 3_600_000;
  still(HOME, h(0), h(8), dense ? 60_000 : 5 * 60_000);
  move(HOME, WORK, h(8), 20 * 60_000, dense ? 5_000 : 10_000);
  still(WORK, h(8) + 21 * 60_000, h(17), dense ? 60_000 : 5 * 60_000);
  move(WORK, HOME, h(17), 100_000, 5_000);
  still(HOME, h(17) + 105_000, h(23.9), dense ? 60_000 : 5 * 60_000);
  return fixes;
}

export function seedDay(userId, deviceId, date, zone, options) {
  const insert = getDb().prepare("INSERT INTO positions (user_id, device_id, ts, lat, lon, accuracy, speed) VALUES (?, ?, ?, ?, ?, NULL, NULL)");
  const fixes = dayFixes(dayBounds(date, zone).from, options);
  for (const f of fixes) insert.run(userId, deviceId, f.ts, f.lat, f.lon);
  return fixes.length;
}

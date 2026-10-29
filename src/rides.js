import { distanceM } from "./history.js";
import { askedLately, recordQuestion } from "./rideAnswers.js";
import { GAP_MS, MIN_VISIT_MS, STOP_RADIUS_M } from "./timeline.js";
import { matchLive } from "./transitMatch.js";

// Rides are watched while they are on, so the rider can say right away whether the server got the
// line right. Per device the fixes since the last stay are kept, the newest BUFFER_MS of them.
// At most every CHECK_EVERY_MS of the ride the timetables are asked (see matchLive), and a match
// is asked about once per ride.
export const BUFFER_MS = 90 * 60_000;
export const CHECK_EVERY_MS = 30_000;

export function createRideWatch() {
  const devices = new Map();

  // Feeds one stored fix of a device. Returns the question to ask, { rideId, transit, at }, or null.
  function observe(userId, deviceId, fix) {
    const key = `${userId}:${deviceId}`;
    let state = devices.get(key);
    if (!state) devices.set(key, (state = { fixes: [], checkedAt: -Infinity, asked: false, seenAt: 0 }));
    state.seenAt = Date.now();
    const last = state.fixes[state.fixes.length - 1];
    if (last && fix.ts <= last.ts) return null;
    // After a long silence nobody knows what happened in between: start over from here.
    if (last && fix.ts - last.ts > GAP_MS) state.fixes = [];
    state.fixes.push(fix);

    // Standing still as long as a visit takes is a stay: the next ride starts from its last fix.
    let first = state.fixes.length - 1;
    while (first > 0 && distanceM(state.fixes[first - 1].lat, state.fixes[first - 1].lon, fix.lat, fix.lon) <= STOP_RADIUS_M) first--;
    if (fix.ts - state.fixes[first].ts >= MIN_VISIT_MS) {
      state.fixes = [fix];
      state.asked = false;
      return null;
    }
    while (fix.ts - state.fixes[0].ts > BUFFER_MS) state.fixes.shift();

    if (state.asked || fix.ts - state.checkedAt < CHECK_EVERY_MS) return null;
    state.checkedAt = fix.ts;
    const match = matchLive(state.fixes);
    if (!match) return null;
    state.asked = true;
    // A halt at a station longer than a visit starts a new ride for the server, not for the rider.
    if (askedLately(userId, deviceId, match.transit.line, fix.ts - BUFFER_MS)) return null;
    const rideId = recordQuestion({ userId, deviceId, boardedAt: match.boardedAt, transit: match.transit, timetable: match.transit.timetable });
    return rideId ? { rideId, transit: match.transit, at: match.boardedAt } : null;
  }

  // Devices that went quiet for longer than a ride may take are let go.
  function sweep(now = Date.now()) {
    for (const [key, state] of devices) if (now - state.seenAt > BUFFER_MS) devices.delete(key);
  }

  return { observe, sweep };
}

import { config } from "./config.js";
import { getDb } from "./db.js";
import { distanceM } from "./history.js";
import { userAgent } from "./overpass.js";

// Trips drawn along the way they really went. With the Balanced or Battery profile of the
// app a fix comes every 15 s or every 2 minutes, and straight lines between them cut every
// corner. A recognised line follows its own course from the timetable; everything else is
// snapped to the roads by an OSRM match service (car, bike or foot). The result replaces the
// trip's path, so every client draws it without knowing about it, and is cached per trip.

// OSRM answers at most this many coordinates per match, longer trips go in pieces.
const MAX_COORDS = 100;
const DEFAULT_RADIUS_M = 25;
const RADIUS_M = { min: 10, max: 50 };
// A match that is much longer than the fixes took a detour the phone never made.
const MAX_STRETCH = 1.5;
const MAX_EXTRA_M = 200;
const TIMEOUT_MS = 10_000;
const RETRY_MS = 10 * 60_000;
const PROFILES = { walking: "foot", cycling: "bike", driving: "car" };

// The public FOSSGIS servers allow one request a second; a queue keeps to that.
let spacingMs = 1_000;
let queue = Promise.resolve();
const inFlight = new Map();
const failedAt = new Map();

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function queued(task) {
  const run = queue.then(task);
  queue = run.catch(() => {}).then(() => pause(spacingMs));
  return run;
}

// Which OSRM profile a trip is snapped with, or null when roads do not describe it: trams,
// trains and ferries keep their fixes, a bus without a known course drives like a car.
export function profileFor(trip) {
  if (trip.mode === "transit") return trip.transit?.kind === "bus" ? "car" : null;
  return PROFILES[trip.mode] ?? null;
}

const lengthOf = (path) => path.reduce((sum, p, i) => (i ? sum + distanceM(path[i - 1][0], path[i - 1][1], p[0], p[1]) : 0), 0);
const round = (value) => Math.round(value * 1e6) / 1e6;

// The fixes of a trip as OSRM wants them: seconds that only go up, a search radius per fix
// from how exact the GPS said it was.
function tracePoints(fixes) {
  const out = [];
  for (const fix of fixes) {
    const second = Math.round(fix.ts / 1000);
    const prev = out[out.length - 1];
    if (prev && second <= prev.second) continue;
    const radius = Number.isFinite(fix.accuracy) && fix.accuracy > 0 ? fix.accuracy : DEFAULT_RADIUS_M;
    out.push({ lat: fix.lat, lon: fix.lon, second, radius: Math.round(Math.min(RADIUS_M.max, Math.max(RADIUS_M.min, radius))) });
  }
  return out;
}

// Pieces of at most MAX_COORDS points, each starting where the one before ended.
export function chunks(points, size = MAX_COORDS) {
  if (points.length <= size) return [points];
  const out = [];
  for (let start = 0; start < points.length - 1; start += size - 1) out.push(points.slice(start, start + size));
  return out;
}

// One OSRM answer into a path: every matching's geometry where its first point comes, and
// the fix itself where OSRM matched nothing between two different matchings (or at the ends).
// A point it left out inside one matching (tidy) is covered by that matching's line already.
export function pathFromMatch(answer, points) {
  const trace = answer.tracepoints ?? [];
  const index = (i) => trace[i]?.matchings_index ?? null;
  const out = [];
  const drawn = new Set();
  for (let i = 0; i < points.length; i++) {
    const m = index(i);
    if (m === null) {
      let before = null;
      for (let k = i - 1; k >= 0 && before === null; k--) before = index(k);
      let after = null;
      for (let k = i + 1; k < points.length && after === null; k++) after = index(k);
      if (before === null || after === null || before !== after) out.push([points[i].lat, points[i].lon]);
      continue;
    }
    if (drawn.has(m)) continue;
    drawn.add(m);
    for (const [lon, lat] of answer.matchings?.[m]?.geometry?.coordinates ?? []) out.push([round(lat), round(lon)]);
  }
  return out;
}

async function askOsrm(profile, points) {
  const base = config.roadMatchUrl.replace("{profile}", profile).replace(/\/+$/, "");
  const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  // Only the time between fixes matters to OSRM, so it never learns when the trip happened.
  const query = new URLSearchParams({
    geometries: "geojson",
    overview: "full",
    timestamps: points.map((p) => p.second - points[0].second).join(";"),
    radiuses: points.map((p) => p.radius).join(";"),
    gaps: "ignore",
    tidy: "true",
  });
  const res = await fetch(`${base}/match/v1/driving/${coords}?${query}`, {
    headers: { "user-agent": userAgent() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  // NoMatch and friends are answers too: this trip does not fit the roads, nothing to retry.
  if (body?.code && body.code !== "Ok" && res.status < 500) return null;
  if (!res.ok || body?.code !== "Ok") throw new Error(`OSRM answered ${res.status}`);
  return body;
}

// The trip snapped to the roads, or null when OSRM found nothing that fits the fixes. The
// first and last point of a trip are the centres of the visits around it (home, often): they
// are not sent, the path is joined to them here.
export async function snapToRoads(fixes, profile) {
  const points = tracePoints(fixes.length > 3 ? fixes.slice(1, -1) : fixes);
  if (points.length < 2) return null;
  const path = [];
  for (const piece of chunks(points)) {
    const answer = await queued(() => askOsrm(profile, piece));
    if (!answer) return null;
    for (const p of pathFromMatch(answer, piece)) {
      const last = path[path.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p);
    }
  }
  if (path.length < 2) return null;
  // The ends stay at the fixes, which sit on the markers of the visits around the trip.
  const first = [fixes[0].lat, fixes[0].lon];
  const last = [fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon];
  const snapped = [first, ...path, last];
  const gps = lengthOf(fixes.map((f) => [f.lat, f.lon]));
  if (lengthOf(snapped) > gps * MAX_STRETCH + MAX_EXTRA_M) return null;
  return snapped;
}

// ---- cache ----

function cachedPath(userId, deviceId, trip, profile) {
  const row = getDb()
    .prepare("SELECT end_ms, path FROM trip_paths WHERE user_id = ? AND device_id = ? AND start = ? AND profile = ?")
    .get(userId, deviceId, trip.start, profile);
  if (!row || Number(row.end_ms) !== trip.end) return undefined;
  return row.path === null ? null : JSON.parse(row.path);
}

function storePath(userId, deviceId, trip, profile, path) {
  getDb()
    .prepare("INSERT OR REPLACE INTO trip_paths (user_id, device_id, start, end_ms, profile, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(userId, deviceId, trip.start, trip.end, profile, path ? JSON.stringify(path) : null, Date.now());
}

const lookupKey = (userId, deviceId, trip, profile) => `${userId}:${deviceId}:${trip.start}:${trip.end}:${profile}`;

// Starts a match in the background, once per trip, and stores what comes back.
function lookup(userId, deviceId, trip, profile) {
  const key = lookupKey(userId, deviceId, trip, profile);
  if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_MS) return null;
  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      snapToRoads(trip.fixes, profile)
        .then((path) => storePath(userId, deviceId, trip, profile, path))
        .catch((error) => {
          failedAt.set(key, Date.now());
          console.warn("Road matching failed:", error.message);
        })
        .finally(() => inFlight.delete(key))
    );
  }
  return inFlight.get(key);
}

// Gives the trips of a timeline their smooth path: the line's course for a recognised ride,
// the roads for the rest. Matches that are not cached yet get up to waitMs, the rest is there
// on the next load (pending). Gaps keep their straight line, nobody knows that way.
export async function smoothPaths(userId, deviceId, segments, { waitMs = 3_000 } = {}) {
  const trips = segments.filter((s) => s.type === "trip" && !s.gap && s.fixes?.length >= 2);
  const waiting = [];
  for (const trip of trips) {
    if (trip.mode === "transit" && trip.transit?.linePath) {
      trip.path = trip.transit.linePath;
      trip.pathSource = "line";
      continue;
    }
    const profile = config.roadMatchUrl ? profileFor(trip) : null;
    if (!profile) continue;
    const cached = cachedPath(userId, deviceId, trip, profile);
    if (cached !== undefined) {
      if (cached) Object.assign(trip, { path: cached, pathSource: "road" });
      continue;
    }
    const run = lookup(userId, deviceId, trip, profile);
    if (run) waiting.push({ trip, profile, run });
  }
  if (!waiting.length) return { pending: false };
  let timer;
  await Promise.race([Promise.all(waiting.map((w) => w.run)), new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
  let pending = false;
  for (const { trip, profile } of waiting) {
    const cached = cachedPath(userId, deviceId, trip, profile);
    // Still running is pending; a failed match keeps the fixes until it may be tried again.
    if (cached === undefined) pending = pending || inFlight.has(lookupKey(userId, deviceId, trip, profile));
    else if (cached) Object.assign(trip, { path: cached, pathSource: "road" });
  }
  return { pending };
}

export function resetPaths({ spacing = 1_000 } = {}) {
  spacingMs = spacing;
  queue = Promise.resolve();
  inFlight.clear();
  failedAt.clear();
}

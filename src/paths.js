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

// ---- leaving the road ----

// A fix this far from the road the match drew was not on it: a field, a park without paths, a
// car park, the far side of a station. At least this, and more for a fix that was vague anyway.
const OFF_ROAD_M = 40;
const offRoadM = (point) => Math.max(OFF_ROAD_M, 1.5 * (point.radius ?? DEFAULT_RADIUS_M));

// Metres east and north of an origin, good enough along one trip.
function projector(lat0, lon0) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * 111_320];
}

// The point of a line nearest to `p`, searched from segment `from` on: which segment, how far
// along it (0 to 1), and how far away.
function nearestOnLine(xy, p, from = 0) {
  let best = { index: from, t: 0, distance: Infinity };
  for (let i = from; i < xy.length - 1; i++) {
    const [ax, ay] = xy[i];
    const [bx, by] = xy[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
    const distance = Math.hypot(p[0] - (ax + dx * t), p[1] - (ay + dy * t));
    if (distance < best.distance) best = { index: i, t, distance };
  }
  return best;
}

const pointAt = (line, cut) => {
  const a = line[cut.index];
  const b = line[Math.min(cut.index + 1, line.length - 1)];
  return [round(a[0] + (b[0] - a[0]) * cut.t), round(a[1] + (b[1] - a[1]) * cut.t)];
};

// The road from one cut of the line to a later one, both ends included.
function roadBetween(line, from, to) {
  if (to.index < from.index || (to.index === from.index && to.t < from.t)) return [pointAt(line, from)];
  return [pointAt(line, from), ...line.slice(from.index + 1, to.index + 1), pointAt(line, to)];
}

// One matching's road, with the fixes that left it. The road is followed as far as the last fix
// on it, a straight line goes out to the fixes off it and back to where the next fix joins the
// road again. A fix OSRM left out (tidy) but close to the road changes nothing.
export function roadWithDetours(coords, points) {
  const line = coords.map(([lon, lat]) => [round(lat), round(lon)]);
  if (line.length < 2 || !points.length) return line;
  const project = projector(line[0][0], line[0][1]);
  const xy = line.map(([lat, lon]) => project(lat, lon));
  const where = points.map((p) => project(p.lat, p.lon));
  const off = points.map((p, i) => nearestOnLine(xy, where[i]).distance > offRoadM(p));
  if (!off.some(Boolean)) return line;

  const out = [];
  let cursor = { index: 0, t: 0 };
  let done = false;
  for (let k = 0; k < points.length; k++) {
    if (!off[k]) continue;
    let r = k;
    while (r + 1 < points.length && off[r + 1]) r++;
    // Along the road up to where the last fix on it was, unless the matching starts off-road.
    if (k > 0) {
      const leave = nearestOnLine(xy, where[k - 1], cursor.index);
      out.push(...roadBetween(line, cursor, leave));
      cursor = leave;
    }
    for (let i = k; i <= r; i++) out.push([points[i].lat, points[i].lon]);
    if (r + 1 < points.length) cursor = nearestOnLine(xy, where[r + 1], cursor.index);
    else done = true;
    k = r;
  }
  if (!done) out.push(...roadBetween(line, cursor, { index: line.length - 2, t: 1 }));
  return out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
}

// The share of matched fixes that lie off the road OSRM drew for them. A few is a detour across
// a square; most of them means the road is not the way the trip went.
export function offRoadShare(answer, points) {
  const trace = answer.tracepoints ?? [];
  const lines = (answer.matchings ?? []).map((m) => {
    const line = (m?.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon]);
    if (line.length < 2) return null;
    const project = projector(line[0][0], line[0][1]);
    return { project, xy: line.map(([lat, lon]) => project(lat, lon)) };
  });
  let matched = 0;
  let off = 0;
  points.forEach((p, i) => {
    const line = lines[trace[i]?.matchings_index ?? -1];
    if (!line) return;
    matched++;
    if (nearestOnLine(line.xy, line.project(p.lat, p.lon)).distance > offRoadM(p)) off++;
  });
  return matched ? off / matched : 1;
}

// Most fixes have to be on the road a match drew, or it is not used.
const MAX_OFF_ROAD_SHARE = 0.5;

// One OSRM answer into a path: every matching's road (with its detours) where its first point
// comes, and the fix itself where OSRM matched nothing between two different matchings (or at
// the ends).
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
    // Every fix from the matching's first to its last, the ones it left out in between too.
    let last = i;
    for (let k = i + 1; k < points.length; k++) if (index(k) === m) last = k;
    out.push(...roadWithDetours(answer.matchings?.[m]?.geometry?.coordinates ?? [], points.slice(i, last + 1)));
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

// A piece OSRM could not match, or matched with a detour, is tried again in halves down to
// this many points: one stretch across a field no longer costs the whole trip its roads.
const MIN_PIECE = 12;

// One piece on the roads: { path, snapped }. What still does not fit keeps its fixes.
async function snapPiece(profile, piece) {
  const answer = await queued(() => askOsrm(profile, piece));
  if (answer) {
    // The roads alone may not be much longer than the fixes (no detour the phone never made),
    // and most fixes have to be on them.
    const gps = lengthOf(piece.map((p) => [p.lat, p.lon]));
    const roads = (answer.matchings ?? []).reduce((sum, m) => sum + lengthOf((m?.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon])), 0);
    if (roads <= gps * MAX_STRETCH + MAX_EXTRA_M && offRoadShare(answer, piece) <= MAX_OFF_ROAD_SHARE) {
      const path = pathFromMatch(answer, piece);
      if (path.length >= 2) return { path, snapped: true };
    }
  }
  if (piece.length < MIN_PIECE * 2) return { path: piece.map((p) => [p.lat, p.lon]), snapped: false };
  const middle = piece.length >> 1;
  const first = await snapPiece(profile, piece.slice(0, middle + 1));
  const second = await snapPiece(profile, piece.slice(middle));
  return { path: [...first.path, ...second.path], snapped: first.snapped || second.snapped };
}

// The trip snapped to the roads, or null when no part of it fits them. Parts that do not fit
// keep their fixes, between parts that do. The first and last point of a trip are the centres
// of the visits around it (home, often): they are not sent, the path is joined to them here.
export async function snapToRoads(fixes, profile) {
  const points = tracePoints(fixes.length > 3 ? fixes.slice(1, -1) : fixes);
  if (points.length < 2) return null;
  const path = [];
  let snapped = false;
  for (const piece of chunks(points)) {
    const part = await snapPiece(profile, piece);
    snapped = snapped || part.snapped;
    for (const p of part.path) {
      const last = path[path.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p);
    }
  }
  if (!snapped || path.length < 2) return null;
  // The ends stay at the fixes, which sit on the markers of the visits around the trip.
  return [[fixes[0].lat, fixes[0].lon], ...path, [fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon]];
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

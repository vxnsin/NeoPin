import { config } from "./config.js";
import { getDb } from "./db.js";
import { distanceM } from "./history.js";
import { userAgent } from "./overpass.js";
import { matchOnRoads } from "./roads/index.js";

// Trips drawn along the way they really went. With the Balanced or Battery profile of the
// app a fix comes every 15 s or every 2 minutes, and straight lines between them cut every
// corner. A recognised line follows its own course from the timetable; everything else is
// snapped to the roads (car, bike or foot): by the server's own matcher on OpenStreetMap roads
// (roads/, the default) or by an OSRM match service (ROAD_MATCH=osrm). The result replaces the
// trip's path, so every client draws it without knowing about it, and is cached per trip.

const DEFAULT_RADIUS_M = 25;
// How far around a fix OSRM looks for its road. A fix the GPS called exact can still sit next
// to the road (a valley, a row of houses), so not less than this. The public FOSSGIS servers
// refuse a radius over 40 m with TooBig, for the whole request.
const RADIUS_M = { min: 20, max: 40 };
// A match that is much longer than the fixes took a detour the phone never made.
const MAX_STRETCH = 1.5;
const MAX_EXTRA_M = 200;
const TIMEOUT_MS = 10_000;
const RETRY_MS = 10 * 60_000;
// Raised whenever snapping gets better: a path stored by an older version, also "no path",
// counts as not cached and the trip is matched again. 2: detours and pieces (1.7.1). 3: radii
// within the public servers' limit, trips with vague fixes had been stored as "no path". 4: at
// most ROAD_MATCH_MAX_COORDS points a request, the public servers refuse more than ten.
// 5: the own matcher (roads/).
export const PATH_ALGO = 5;
const PROFILES = { walking: "foot", cycling: "bike", driving: "car" };

// The public FOSSGIS servers allow one request a second; a queue keeps to that.
let spacingMs = 1_000;
let queue = Promise.resolve();
const inFlight = new Map();
const failedAt = new Map();
let warnedTooBig = false;

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
const between = (a, b) => distanceM(a.lat, a.lon, b.lat, b.lon);

// Two fixes this close in time and space are one: the app's foreground watch and its
// background task can both report the same fix.
const REPEAT_MS = 2_000;
const REPEAT_M = 2;

// The fixes of a trip as OSRM wants them: seconds that only go up, a search radius per fix
// from how exact the GPS said it was, repeats left out.
export function tracePoints(fixes) {
  const out = [];
  for (const fix of fixes) {
    const second = Math.round(fix.ts / 1000);
    const prev = out[out.length - 1];
    if (prev && (second <= prev.second || (fix.ts - prev.ts <= REPEAT_MS && between(prev, fix) < REPEAT_M))) continue;
    const radius = Number.isFinite(fix.accuracy) && fix.accuracy > 0 ? fix.accuracy : DEFAULT_RADIUS_M;
    out.push({ lat: fix.lat, lon: fix.lon, ts: fix.ts, second, radius: Math.round(Math.min(RADIUS_M.max, Math.max(RADIUS_M.min, radius))) });
  }
  return out;
}

// ---- fewer points ----

// The public servers match at most ten points a request, so a dense trace is thinned first: a
// point every this many metres along the way, and one where the way turns. A server that takes
// many points a request (ROAD_MATCH_MAX_COORDS) gets every fix.
const SPACING_M = 120;
const DENSE_COORDS = 50;
const TURN_DEG = 30;
// A fix closer than this to the last one kept adds nothing.
const NEAR_M = 5;
// Requests one trip may take in the first round (the spacing grows until it fits), and the
// requests on top for windows that did not match at first.
const MAX_WINDOWS = 20;
const MAX_RETRIES = 10;

const bearing = (a, b) => Math.atan2((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat);

// Whether the way turns at fix i, coming from the last point kept.
function turnsAt(trace, i, kept) {
  const p = trace[i];
  let j = i + 1;
  while (j < trace.length - 1 && between(p, trace[j]) < 20) j++;
  const turn = Math.abs(bearing(kept, p) - bearing(p, trace[j]));
  return (Math.min(turn, 2 * Math.PI - turn) * 180) / Math.PI > TURN_DEG;
}

// The points sent to OSRM, a subset of the trace: always its first and last point, then one
// every `spacing` metres along the way and one where it turns.
function thinOut(trace, spacing) {
  if (trace.length <= 2) return trace;
  const out = [trace[0]];
  let along = 0;
  for (let i = 1; i < trace.length - 1; i++) {
    along += between(trace[i - 1], trace[i]);
    const kept = out[out.length - 1];
    const away = between(kept, trace[i]);
    if (away < NEAR_M) continue;
    if (along >= spacing || (away >= spacing / 4 && turnsAt(trace, i, kept))) {
      out.push(trace[i]);
      along = 0;
    }
  }
  const last = trace[trace.length - 1];
  if (out.length > 1 && between(out[out.length - 1], last) < NEAR_M) out.pop();
  out.push(last);
  return out;
}

// Thinned so that the trip fits into MAX_WINDOWS requests.
export function thinTrace(trace, size = config.roadMatchMaxCoords) {
  const most = MAX_WINDOWS * (size - 2) + 2;
  let spacing = size >= DENSE_COORDS ? 0 : SPACING_M;
  let out = thinOut(trace, spacing);
  while (out.length > most) {
    spacing = Math.max(spacing * 1.25, SPACING_M);
    out = thinOut(trace, spacing);
  }
  return out;
}

// Windows of at most `size` points as [first, last] index, each sharing its last two points with
// the next one: the second to last is where the two are joined, the last tells the earlier
// window which way the road goes on from there.
export function windows(count, size = config.roadMatchMaxCoords) {
  if (count <= size) return [[0, count - 1]];
  const out = [];
  for (let from = 0; ; from += size - 2) {
    const to = Math.min(from + size - 1, count - 1);
    out.push([from, to]);
    if (to === count - 1) break;
  }
  const last = out[out.length - 1];
  last[0] = Math.min(last[0], count - 3);
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

// The point of a line nearest to `p`, searched on the segments from `from` to before `to`:
// which segment, how far along it (0 to 1), and how far away.
function nearestOnLine(xy, p, from = 0, to = xy.length - 1) {
  let best = { index: Math.max(0, Math.min(from, xy.length - 2)), t: 0, distance: Infinity };
  for (let i = from; i < Math.min(to, xy.length - 1); i++) {
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
// road again. A fix OSRM left out (tidy, or never sent) but close to the road changes nothing.
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

// The share of fixes, also the ones never sent, that lie off every road an answer drew. A few
// is a detour across a square; most of them means the roads are not the way the trip went.
export function offRoadShare(answer, fixes) {
  const lines = (answer.matchings ?? [])
    .map((m) => (m?.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon]))
    .filter((line) => line.length >= 2)
    .map((line) => {
      const project = projector(line[0][0], line[0][1]);
      return { project, xy: line.map(([lat, lon]) => project(lat, lon)) };
    });
  if (!lines.length || !fixes.length) return 1;
  const off = fixes.filter((p) => lines.every((l) => nearestOnLine(l.xy, l.project(p.lat, p.lon)).distance > offRoadM(p)));
  return off.length / fixes.length;
}

// Most fixes have to be on the roads a match drew, or it is not used.
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

// The answer, or null when OSRM says it does not fit (NoMatch, TooBig and friends): nothing to
// retry later. `wide` searches every point's road as far as the servers allow.
async function askOsrm(profile, points, wide) {
  const base = config.roadMatchUrl.replace("{profile}", profile).replace(/\/+$/, "");
  const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  // Only the time between fixes matters to OSRM, so it never learns when the trip happened.
  const query = new URLSearchParams({
    geometries: "geojson",
    overview: "full",
    timestamps: points.map((p) => p.second - points[0].second).join(";"),
    radiuses: points.map((p) => (wide ? RADIUS_M.max : p.radius)).join(";"),
    gaps: "ignore",
    tidy: "true",
  });
  const res = await fetch(`${base}/match/v1/driving/${coords}?${query}`, {
    headers: { "user-agent": userAgent() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (body?.code === "TooBig" && !warnedTooBig) {
    warnedTooBig = true;
    console.warn(`Road matching: ${points.length} points are too many for the server (TooBig), lower ROAD_MATCH_MAX_COORDS`);
  }
  if (body?.code && body.code !== "Ok" && res.status < 500) return null;
  if (!res.ok || body?.code !== "Ok") throw new Error(`OSRM answered ${res.status}`);
  return body;
}

// One window on the roads, or null. The roads may not be much longer than the fixes they stand
// for (no detour the phone never made), and most fixes, also the ones not sent, have to be on
// them; the ones that are not get their detour.
async function matchWindow(profile, points, fixes, wide) {
  const answer = await queued(() => askOsrm(profile, points, wide));
  if (!answer) return null;
  const gps = lengthOf(fixes.map((p) => [p.lat, p.lon]));
  const roads = (answer.matchings ?? []).reduce((sum, m) => sum + lengthOf((m?.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon])), 0);
  if (roads > gps * MAX_STRETCH + MAX_EXTRA_M || offRoadShare(answer, fixes) > MAX_OFF_ROAD_SHARE) return null;
  const matched = pathFromMatch(answer, points).map(([lat, lon]) => [lon, lat]);
  const path = roadWithDetours(matched, fixes);
  return path.length >= 2 ? path : null;
}

// Points `from` to `to` of the thinned trace on the roads: [{ from, to, path, snapped }]. A window
// that does not match is asked once more with every radius at the most, then in two halves; what
// still does not fit keeps its fixes. `budget.left` caps the requests on top for one trip.
async function snapWindow(profile, points, trace, from, to, budget, wide = false) {
  const part = points.slice(from, to + 1);
  const fixes = trace.slice(points[from].index, points[to].index + 1);
  let path = await matchWindow(profile, part, fixes, wide);
  if (!path && !wide && budget.left > 0 && part.some((p) => p.radius < RADIUS_M.max)) {
    budget.left--;
    path = await matchWindow(profile, part, fixes, true);
  }
  if (path) return [{ from, to, path, snapped: true }];
  if (part.length >= 6 && budget.left >= 2) {
    budget.left -= 2;
    const middle = (from + to) >> 1;
    return [
      ...(await snapWindow(profile, points, trace, from, middle + 1, budget, true)),
      ...(await snapWindow(profile, points, trace, middle, to, budget, true)),
    ];
  }
  return [{ from, to, path: fixes.map((p) => [p.lat, p.lon]), snapped: false }];
}

// The windows joined into one path. Each is cut where it comes nearest to the first point of the
// next one, and the next one starts where it comes nearest to that cut: no kink, no going back
// and forth where two windows saw the road a little differently.
export function stitch(parts, points) {
  const out = [];
  parts.forEach((part, k) => {
    let line = part.path;
    const project = projector(line[0][0], line[0][1]);
    const at = (p) => project(p.lat, p.lon);
    if (out.length) {
      const xy = line.map(([lat, lon]) => project(lat, lon));
      const end = out[out.length - 1];
      const limit = nearestOnLine(xy, at(points[Math.min(part.from + 1, part.to)])).index;
      const head = nearestOnLine(xy, project(end[0], end[1]), 0, limit + 1);
      line = [pointAt(line, head), ...line.slice(head.index + 1)];
    }
    const next = parts[k + 1];
    if (next && line.length >= 2) {
      const xy = line.map(([lat, lon]) => project(lat, lon));
      const start = next.from - 1 >= part.from ? nearestOnLine(xy, at(points[next.from - 1])).index : 0;
      const cut = nearestOnLine(xy, at(points[next.from]), start);
      line = [...line.slice(0, cut.index + 1), pointAt(line, cut)];
    }
    for (const p of line) {
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
  });
  return out;
}

// The trip snapped to the roads, or null when no part of it fits them. Parts that do not fit
// keep their fixes, between parts that do. The first and last point of a trip are the centres
// of the visits around it (home, often): they are not sent, the path is joined to them here.
export async function snapToRoads(fixes, profile) {
  const trace = tracePoints(fixes.length > 3 ? fixes.slice(1, -1) : fixes).map((p, index) => ({ ...p, index }));
  if (trace.length < 2) return null;
  const points = thinTrace(trace);
  const budget = { left: MAX_RETRIES };
  const parts = [];
  for (const [from, to] of windows(points.length)) parts.push(...(await snapWindow(profile, points, trace, from, to, budget)));
  if (!parts.some((p) => p.snapped)) return null;
  const path = stitch(parts, points);
  if (path.length < 2) return null;
  // The ends stay at the fixes, which sit on the markers of the visits around the trip.
  return [[fixes[0].lat, fixes[0].lon], ...path, [fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon]];
}

// The trip on the roads by the own matcher (roads/), or null. As with OSRM, the visit centres
// at both ends are left out of the matching and joined to the path afterwards.
export async function snapOwn(fixes, profile) {
  const inner = fixes.length > 3 ? fixes.slice(1, -1) : fixes;
  const match = await matchOnRoads(inner, profile);
  if (!match) return null;
  const path = [[fixes[0].lat, fixes[0].lon], ...match.path, [fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon]];
  return path.filter((p, i) => i === 0 || p[0] !== path[i - 1][0] || p[1] !== path[i - 1][1]);
}

// Which matcher snaps the trips, or null when none does.
function matcher() {
  if (config.roadMatch === "own") return snapOwn;
  if (config.roadMatch === "osrm" && config.roadMatchUrl) return snapToRoads;
  return null;
}

// ---- cache ----

function cachedPath(userId, deviceId, trip, profile) {
  const row = getDb()
    .prepare("SELECT end_ms, path, algo FROM trip_paths WHERE user_id = ? AND device_id = ? AND start = ? AND profile = ?")
    .get(userId, deviceId, trip.start, profile);
  if (!row || Number(row.end_ms) !== trip.end || Number(row.algo) !== PATH_ALGO) return undefined;
  return row.path === null ? null : JSON.parse(row.path);
}

function storePath(userId, deviceId, trip, profile, path) {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO trip_paths (user_id, device_id, start, end_ms, profile, path, created_at, algo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(userId, deviceId, trip.start, trip.end, profile, path ? JSON.stringify(path) : null, Date.now(), PATH_ALGO);
}

const lookupKey = (userId, deviceId, trip, profile) => `${userId}:${deviceId}:${trip.start}:${trip.end}:${profile}`;

// Starts a match in the background, once per trip, and stores what comes back.
function lookup(userId, deviceId, trip, profile) {
  const key = lookupKey(userId, deviceId, trip, profile);
  if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_MS) return null;
  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      matcher()(trip.fixes, profile)
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
// on the next load (pending). Gaps keep their straight line, nobody knows that way. `withheld`
// trips (see matchTransit) keep their fixes: a stored path was snapped from all of them.
export async function smoothPaths(userId, deviceId, segments, { waitMs = 3_000, withheld = () => false } = {}) {
  const trips = segments.filter((s) => s.type === "trip" && !s.gap && s.fixes?.length >= 2 && !withheld(s));
  const waiting = [];
  for (const trip of trips) {
    if (trip.mode === "transit" && trip.transit?.linePath) {
      trip.path = trip.transit.linePath;
      trip.pathSource = "line";
      continue;
    }
    const profile = matcher() ? profileFor(trip) : null;
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
  warnedTooBig = false;
}

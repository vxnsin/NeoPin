import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { distanceM, recordPosition } from "../src/history.js";
import { PATH_ALGO, pathFromMatch, profileFor, roadWithDetours, stitch, thinTrace, windows } from "../src/paths.js";
import { deviceHeaders, startServer } from "./helpers.js";

const MIN = 60_000;
const DAY = "2025-06-10";
const DAY0 = Date.UTC(2025, 5, 10);
// Snapped points sit this far east of the fixes, about 4 m: easy to tell apart.
const SHIFT = 0.00005;
const east = (lon, shift = SHIFT) => Math.round((lon + shift) * 1e6) / 1e6;

test("the thinned trace goes to OSRM in windows of at most ten points that share two", () => {
  assert.deepEqual(windows(25, 10), [
    [0, 9],
    [8, 17],
    [16, 24],
  ]);
  assert.deepEqual(windows(10, 10), [[0, 9]]);
  assert.deepEqual(windows(19, 10).at(-1), [16, 18], "the last one has three points at least");
  assert.deepEqual(windows(250, 100), [
    [0, 99],
    [98, 197],
    [196, 249],
  ]);
});

// A trace heading north `northM` and then east `eastM`, a fix every `stepM`.
function lShaped(northM, eastM, stepM) {
  const kx = 111_320 * Math.cos((48 * Math.PI) / 180);
  const out = [];
  for (let d = 0; d <= northM; d += stepM) out.push({ lat: 48 + d / 111_320, lon: 11 });
  for (let d = stepM; d <= eastM; d += stepM) out.push({ lat: 48 + northM / 111_320, lon: 11 + d / kx });
  return out.map((p, index) => ({ ...p, index, radius: 20 }));
}

test("a dense trace is thinned: a point every 120 m, the corner, both ends", () => {
  const trace = lShaped(1000, 1000, 10);
  const thin = thinTrace(trace, 10);
  assert.ok(thin.length >= 15 && thin.length <= 22, `${thin.length} points`);
  assert.equal(thin[0], trace[0]);
  assert.equal(thin.at(-1), trace.at(-1));
  const corner = { lat: 48 + 1000 / 111_320, lon: 11 };
  assert.ok(thin.some((p) => distanceM(p.lat, p.lon, corner.lat, corner.lon) < 25), "the turn is kept");
  assert.ok(thin.every((p, i) => !i || distanceM(thin[i - 1].lat, thin[i - 1].lon, p.lat, p.lon) <= 130), "no longer gaps than the spacing");
  // A server that takes 100 points a request gets every fix.
  assert.equal(thinTrace(trace, 100).length, trace.length);
  // A long trip still fits into twenty requests.
  const long = lShaped(60_000, 40_000, 20);
  const few = thinTrace(long, 10);
  assert.ok(windows(few.length, 10).length <= 20, `${few.length} points`);
});

test("two windows that saw the road a little differently are joined without going back", () => {
  const points = Array.from({ length: 14 }, (_, i) => ({ lat: 48 + i / 1000, lon: 11 }));
  const along = (from, to, shift) => points.slice(from, to + 1).map((p) => [p.lat, east(p.lon, shift)]);
  const path = stitch(
    [
      { from: 0, to: 9, path: along(0, 9, SHIFT) },
      { from: 8, to: 13, path: along(8, 13, 2 * SHIFT) },
    ],
    points
  );
  assert.deepEqual(path[0], [48, east(11)]);
  assert.deepEqual(path.at(-1), [48.013, east(11, 2 * SHIFT)]);
  assert.ok(path.every(([lat], i) => !i || lat >= path[i - 1][0]), "only ever north, a step aside where they meet");
  // The first window up to the point the second starts with, the second from there.
  assert.ok(path.some(([lat, lon]) => lat === 48.008 && lon === east(11)));
  assert.ok(!path.some(([lat, lon]) => lat === 48.009 && lon === east(11)));
});

test("a match becomes a path: each matching once, a fix where nothing matched between two", () => {
  // Fixes 0 to 2 on the first road, 3 between the roads, 4 and 5 on the second.
  const lons = [11.1, 11.1, 11.1, 11, 11.2, 11.2];
  const points = lons.map((lon, i) => ({ lat: 48 + i / 1000, lon }));
  const answer = {
    matchings: [{ geometry: { coordinates: [[11.1, 48], [11.1, 48.002]] } }, { geometry: { coordinates: [[11.2, 48.004], [11.2, 48.005]] } }],
    // Point 1 was tidied away inside the first matching, point 3 matched nothing between the two.
    tracepoints: [{ matchings_index: 0 }, null, { matchings_index: 0 }, null, { matchings_index: 1 }, { matchings_index: 1 }],
  };
  assert.deepEqual(pathFromMatch(answer, points), [
    [48, 11.1],
    [48.002, 11.1],
    [48.003, 11],
    [48.004, 11.2],
    [48.005, 11.2],
  ]);
});

test("a fix off the road: the road as far as the last fix on it, out to the fix, back where the next joins", () => {
  // A road due north, a vertex every ~110 m. The third fix is ~150 m east of it, in a field.
  const coords = Array.from({ length: 11 }, (_, i) => [11, 48 + i / 1000]);
  const points = [
    { lat: 48, lon: 11 },
    { lat: 48.002, lon: 11 },
    { lat: 48.004, lon: 11.002 },
    { lat: 48.006, lon: 11 },
    { lat: 48.01, lon: 11 },
  ];
  assert.deepEqual(roadWithDetours(coords, points), [
    [48, 11],
    [48.001, 11],
    [48.002, 11],
    [48.004, 11.002],
    [48.006, 11],
    [48.007, 11],
    [48.008, 11],
    [48.009, 11],
    [48.01, 11],
  ]);
  // Fixes close to the road, also ones OSRM tidied away, leave the road as it is.
  const near = points.map((p) => ({ ...p, lon: 11.0002 }));
  assert.deepEqual(roadWithDetours(coords, near), coords.map(([lon, lat]) => [lat, lon]));
});

test("each mode has its profile, rides without a road keep their fixes", () => {
  assert.equal(profileFor({ mode: "walking" }), "foot");
  assert.equal(profileFor({ mode: "cycling" }), "bike");
  assert.equal(profileFor({ mode: "driving" }), "car");
  assert.equal(profileFor({ mode: "transit", transit: { kind: "bus" } }), "car");
  assert.equal(profileFor({ mode: "transit", transit: { kind: "tram" } }), null);
  assert.equal(profileFor({ mode: "transit", transit: null }), null);
});

// Like the public FOSSGIS servers: more than ten points or a search radius over 40 m fail the
// whole request with TooBig.
const FOSSGIS_MAX_COORDS = 10;
const FOSSGIS_MAX_RADIUS_M = 40;

// A stand-in for OSRM: snaps every point a little to the east, or answers with `reply`.
function fakeOsrm() {
  const calls = [];
  let reply = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const match = /^\/routed-(\w+)\/match\/v1\/driving\/(.+)$/.exec(url.pathname);
    const coords = match[2].split(";").map((pair) => pair.split(",").map(Number));
    const radii = (url.searchParams.get("radiuses") ?? "").split(";").map(Number);
    calls.push({ profile: match[1], count: coords.length, timestamps: url.searchParams.get("timestamps"), radiuses: url.searchParams.get("radiuses") });
    res.setHeader("content-type", "application/json");
    if (coords.length > FOSSGIS_MAX_COORDS) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ code: "TooBig", message: "Too many trace coordinates" }));
    }
    if (radii.some((r) => r > FOSSGIS_MAX_RADIUS_M)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ code: "TooBig", message: "Radius search size is too large for map matching." }));
    }
    if (reply) {
      const body = reply.body(coords, url, calls.length);
      res.statusCode = reply.status ?? (body.code === "Ok" ? 200 : 400);
      return res.end(JSON.stringify(body));
    }
    res.end(JSON.stringify(onTheRoad(coords.map(([lon, lat]) => [lon + SHIFT, lat]))));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/routed-{profile}`,
        calls,
        answer: (next) => (reply = next),
        close: () => new Promise((done) => server.close(done)),
      })
    )
  );
}

// One matching along `road` ([lon, lat]), every point sent on it.
const onTheRoad = (road, count = road.length) => ({
  code: "Ok",
  matchings: [{ confidence: 0.9, geometry: { coordinates: road } }],
  tracepoints: Array.from({ length: count }, (_, i) => ({ matchings_index: 0, waypoint_index: i })),
});

let s;
let luis;
let osrm;
beforeEach(async () => {
  s = await startServer();
  luis = await s.account("luis");
  osrm = await fakeOsrm();
  config.roadMatch = "osrm";
  config.roadMatchUrl = osrm.url;
});
afterEach(async () => {
  config.roadMatch = "off";
  config.roadMatchUrl = null;
  await osrm.close();
  await s.stop();
});

const record = (fixes) => fixes.forEach((f) => recordPosition(luis.user.id, "phone", f.lat, f.lon, f.ts, { accuracy: f.accuracy ?? null }));
// What servers before this one stored when the app reported a fix twice.
const storeTwice = (fixes) =>
  fixes.forEach((f) => {
    for (let copy = 0; copy < 2; copy++) {
      getDb()
        .prepare("INSERT INTO positions (user_id, device_id, ts, lat, lon, accuracy, speed) VALUES (?, 'phone', ?, ?, ?, ?, NULL)")
        .run(luis.user.id, f.ts, f.lat, f.lon, f.accuracy ?? null);
    }
  });

// A stay, then `count` fixes `everyS` apart heading north at `speedMs`, then a stay. `offsetM`
// puts the fixes that far east and west of the road, by turns.
function aDay(count, speedMs = 12, everyS = 5, { twice = false, offsetM = 0 } = {}) {
  const home = { lat: 48.1, lon: 11.5 };
  record([0, 5, 10].map((m) => ({ ts: DAY0 + m * MIN, ...home })));
  const step = (speedMs * everyS) / 111_320;
  const kx = 111_320 * Math.cos((home.lat * Math.PI) / 180);
  const fixes = Array.from({ length: count }, (_, i) => ({
    ts: DAY0 + 11 * MIN + (i + 1) * everyS * 1000,
    lat: home.lat + (i + 1) * step,
    lon: home.lon + ((i % 2 ? 1 : -1) * offsetM) / kx,
    accuracy: 4,
  }));
  if (twice) storeTwice(fixes);
  else record(fixes);
  const last = fixes[fixes.length - 1];
  record([1, 6, 11].map((m) => ({ ts: last.ts + m * MIN, lat: last.lat, lon: home.lon })));
  return fixes;
}

const timeline = async () => {
  const res = await fetch(`${s.baseUrl}/api/timeline?deviceId=phone&date=${DAY}&tz=0`, { headers: deviceHeaders("phone", luis.token) });
  assert.equal(res.status, 200);
  return res.json();
};

const theTrip = (body) => body.segments.find((seg) => seg.type === "trip");
const sentAtMost = (count) => osrm.calls.every((c) => c.count <= count);

test("a drive is snapped to the roads and cached", async () => {
  aDay(20);
  const body = await timeline();
  assert.equal(body.pathsPending, false);
  const trip = theTrip(body);
  assert.equal(trip.mode, "driving");
  assert.equal(trip.pathSource, "road");
  const [visit] = body.segments;
  assert.deepEqual(trip.path[0], [visit.lat, visit.lon], "still starts at the marker of the visit");
  assert.deepEqual(trip.path.at(-1), [body.segments[2].lat, body.segments[2].lon], "and ends at the next one");
  assert.ok(
    trip.path.slice(1, -1).every(([, lon]) => lon === east(11.5)),
    "in between it follows the road"
  );
  assert.ok(osrm.calls.length >= 1 && osrm.calls.length <= 2, `${osrm.calls.length} requests`);
  assert.ok(sentAtMost(10));
  assert.equal(osrm.calls[0].profile, "car");
  assert.match(osrm.calls[0].radiuses, /^20;20;/, "radii from the accuracy, at least 20 m");
  const seconds = osrm.calls[0].timestamps.split(";").map(Number);
  assert.equal(seconds[0], 0, "times are relative to the start, OSRM never learns when the trip was");
  assert.ok(seconds.every((t, i) => i === 0 || t > seconds[i - 1]), "and only go up");
  assert.ok(trip.distanceM > 1000 && trip.distanceM < 1300, "the distance stays the one of the fixes");

  const asked = osrm.calls.length;
  const again = theTrip(await timeline());
  assert.deepEqual(again.path, trip.path);
  assert.equal(osrm.calls.length, asked, "the second load comes from the cache");
});

test("a dense 20 km drive, every fix stored twice, is snapped whole in at most twenty requests", async () => {
  // A fix every 100 m, as the app sends them on a road out of town.
  const fixes = aDay(200, 20, 5, { twice: true });
  // Twenty requests one after the other can take longer than one load waits on a busy machine.
  let body = await timeline();
  for (let i = 0; i < 20 && body.pathsPending; i++) body = await timeline();
  const trip = theTrip(body);
  assert.equal(trip.mode, "driving");
  assert.equal(trip.pathSource, "road");
  assert.ok(osrm.calls.length <= 20, `${osrm.calls.length} requests`);
  assert.ok(sentAtMost(10), "never more than the public servers take");
  assert.ok(osrm.calls.every((c) => c.timestamps.split(";").map(Number).every((t, i, all) => !i || t > all[i - 1])), "each fix once");
  const inner = trip.path.slice(1, -1);
  assert.ok(inner.every(([, lon]) => lon === east(11.5)), "on the road all the way");
  assert.ok(inner[0][0] <= fixes[1].lat && inner.at(-1)[0] >= fixes.at(-2).lat, "from the start to the end");
  assert.ok(inner.every(([lat], i) => !i || lat > inner[i - 1][0]), "without going back and forth where windows meet");
  assert.ok(Math.abs(trip.distanceM - 19_900) < 300, `${trip.distanceM} m, each fix counted once`);
});

test("windows that each see the road a little differently still give one line forward", async () => {
  osrm.answer({ body: (coords, url, call) => onTheRoad(coords.map(([lon, lat]) => [lon + SHIFT * (1 + (call % 2)), lat])) });
  aDay(120, 20, 5);
  const trip = theTrip(await timeline());
  assert.equal(trip.pathSource, "road");
  const inner = trip.path.slice(1, -1);
  assert.ok(inner.every(([lat], i) => !i || lat >= inner[i - 1][0]), "only ever north");
  assert.ok(inner.every(([lat, lon], i) => !i || distanceM(inner[i - 1][0], inner[i - 1][1], lat, lon) <= 250), "no jumps, a vertex at least every second fix");
});

test("fixes recorded next to the road land on it", async () => {
  // The road runs due north at 11.5; the fixes are 25 m beside it, by turns, and claim to be
  // exact to 4 m. OSRM finds no road within a radius smaller than that.
  const kx = 111_320 * Math.cos((48.1 * Math.PI) / 180);
  osrm.answer({
    body: (coords, url) => {
      const radii = url.searchParams.get("radiuses").split(";").map(Number);
      if (coords.some(([lon], i) => Math.abs(lon - 11.5) * kx > radii[i])) return { code: "NoMatch", message: "Could not match the trace." };
      return onTheRoad(coords.map(([, lat]) => [11.5, lat]));
    },
  });
  aDay(30, 12, 5, { offsetM: 25 });
  const trip = theTrip(await timeline());
  assert.equal(trip.pathSource, "road");
  assert.ok(trip.path.slice(1, -1).every(([, lon]) => lon === 11.5), "on the road, no detours out to the fixes");
  assert.ok(osrm.calls.some((c) => c.radiuses.split(";").every((r) => r === "40")), "asked again with the widest radius");
  assert.ok(sentAtMost(10));
});

test("a server refusing the size (TooBig) is logged once, smaller windows still match", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  config.roadMatchMaxCoords = 20;
  try {
    aDay(60);
    const trip = theTrip(await timeline());
    assert.equal(trip.pathSource, "road", "the halves fit");
    assert.ok(trip.path.slice(1, -1).every(([, lon]) => lon === east(11.5)));
    assert.ok(osrm.calls.some((c) => c.count > 10));
    assert.equal(warn.mock.calls.filter((c) => /TooBig/.test(c.arguments[0])).length, 1);
  } finally {
    config.roadMatchMaxCoords = 10;
  }
});

test("one fix reported twice is stored once, and a day stored twice draws each fix once", async () => {
  const at = DAY0 + 30 * MIN;
  assert.equal(recordPosition(luis.user.id, "phone", 48.2, 11.6, at, { accuracy: 5 }), true);
  assert.equal(recordPosition(luis.user.id, "phone", 48.2, 11.6, at, { accuracy: 5 }), false, "the same fix from the other reporter");
  // Late from a batch, the same fix again: also not stored.
  assert.equal(recordPosition(luis.user.id, "phone", 48.2, 11.6, at + 500, { accuracy: 5 }), false);
  assert.equal(Number(getDb().prepare("SELECT COUNT(*) AS n FROM positions").get().n), 1);

  getDb().prepare("DELETE FROM positions").run();
  config.roadMatchUrl = null;
  aDay(30, 12, 5, { twice: true });
  const trip = theTrip(await timeline());
  assert.ok(trip.path.every((p, i) => !i || p[0] !== trip.path[i - 1][0] || p[1] !== trip.path[i - 1][1]), "no point twice in a row");
});

test("a walk goes to the foot profile", async () => {
  aDay(60, 1.4, 12);
  const trip = theTrip(await timeline());
  assert.equal(trip.mode, "walking");
  assert.equal(osrm.calls[0].profile, "foot");
});

test("a match with a detour the phone never made is not used, and not asked again", async () => {
  osrm.answer({
    body: (coords) => onTheRoad([coords[0], [coords[0][0] + 0.1, coords[0][1]], coords[coords.length - 1]], coords.length),
  });
  aDay(20);
  const trip = theTrip(await timeline());
  assert.equal(trip.pathSource, undefined);
  assert.ok(trip.path.every(([, lon]) => lon === 11.5), "the fixes themselves");
  const asked = osrm.calls.length;
  assert.ok(asked <= 1 + 10, "the requests on top are capped");
  await timeline();
  assert.equal(osrm.calls.length, asked);
  assert.equal(getDb().prepare("SELECT path FROM trip_paths").get().path, null);
});

test("a path an older version stored, also no path, is matched again", async () => {
  aDay(20);
  assert.equal(theTrip(await timeline()).pathSource, "road");
  const first = osrm.calls.length;
  // What 1.6.0 left behind when the whole trip had to fit at once.
  getDb().prepare("UPDATE trip_paths SET path = NULL, algo = 1").run();
  const trip = theTrip(await timeline());
  assert.equal(trip.pathSource, "road");
  assert.equal(osrm.calls.length, 2 * first);
  assert.equal(getDb().prepare("SELECT algo FROM trip_paths").get().algo, PATH_ALGO);
  await timeline();
  assert.equal(osrm.calls.length, 2 * first, "the new answer is cached again");
});

test("a part that fits no road keeps its fixes, the rest of the trip is still snapped", async () => {
  const fixes = aDay(40);
  // Everything after the twenty-fifth fix is a way OSRM cannot match.
  const cutoff = fixes[24].lat;
  osrm.answer({
    body: (coords) =>
      coords.some(([, lat]) => lat > cutoff)
        ? { code: "NoMatch", message: "Could not match the trace." }
        : onTheRoad(coords.map(([lon, lat]) => [lon + SHIFT, lat])),
  });
  const trip = theTrip(await timeline());
  assert.equal(trip.pathSource, "road", "one piece that does not fit no longer costs the whole trip its roads");
  const inner = trip.path.slice(1, -1);
  assert.ok(inner.some(([, lon]) => lon === east(11.5)), "the first part is on the road");
  assert.ok(inner.some(([lat, lon]) => lon === 11.5 && lat > cutoff), "the rest keeps its fixes");
  assert.ok(inner.every(([lat], i) => !i || lat >= inner[i - 1][0]), "the two join without going back");
});

test("no match keeps the fixes, a broken server is tried again later and is not pending", async () => {
  osrm.answer({ body: () => ({ code: "NoMatch", message: "Could not match the trace." }) });
  aDay(20);
  const noMatch = await timeline();
  assert.equal(theTrip(noMatch).pathSource, undefined);
  assert.equal(noMatch.pathsPending, false);

  getDb().prepare("DELETE FROM trip_paths").run();
  const before = osrm.calls.length;
  osrm.answer({ status: 502, body: () => ({ message: "busy" }) });
  const broken = await timeline();
  assert.equal(theTrip(broken).pathSource, undefined);
  assert.equal(broken.pathsPending, false, "nothing is running anymore");
  await timeline();
  assert.equal(osrm.calls.length, before + 1, "the failure is not retried right away");
});

test("with ROAD_MATCH_URL off nothing is asked and the fixes stay", async () => {
  config.roadMatchUrl = null;
  aDay(20);
  const body = await timeline();
  assert.equal(theTrip(body).pathSource, undefined);
  assert.equal(body.pathsPending, false);
  assert.equal(osrm.calls.length, 0);
});

test("a database from before keeps its stored lines and gains the column for their course", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { initDb, closeDb } = await import("../src/db.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neopin-db-"));
  const file = path.join(dir, "old.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE trip_transit (user_id INTEGER NOT NULL, device_id TEXT NOT NULL, start INTEGER NOT NULL,
    end_ms INTEGER NOT NULL, transit TEXT, data_stamp INTEGER NOT NULL, PRIMARY KEY (user_id, device_id, start))`);
  old.prepare("INSERT INTO trip_transit VALUES (1, 'phone', 1, 2, NULL, 0)").run();
  old.close();
  try {
    const db = initDb(file);
    assert.ok(db.prepare("PRAGMA table_info(trip_transit)").all().some((c) => c.name === "path"));
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM trip_transit").get().n), 1);
  } finally {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Like the public servers: a few sparse points come back as one matching along a road drawn
// with many points, the points themselves a little east of the fixes.
function alongARoad(coords) {
  const road = [];
  coords.forEach(([lon, lat], i) => {
    if (!i) return road.push([lon + SHIFT, lat]);
    const [lon0, lat0] = coords[i - 1];
    for (let k = 1; k <= 20; k++) road.push([lon0 + ((lon - lon0) * k) / 20 + SHIFT, lat0 + ((lat - lat0) * k) / 20]);
  });
  return onTheRoad(road, coords.length);
}

test("a sparse drive with vague fixes (Battery profile) is snapped: no radius over what public servers allow", async () => {
  osrm.answer({ body: alongARoad });
  const home = { lat: 48.1, lon: 11.5 };
  record([0, 5, 10].map((m) => ({ ts: DAY0 + m * MIN, ...home })));
  // 4 km in 5 minutes, a fix every 75 s, as exact as a phone saving its battery says it is.
  const fixes = [60, 90, 35].map((accuracy, i) => ({ ts: DAY0 + 10 * MIN + (i + 1) * 75_000, lat: home.lat + ((i + 1) * 1000) / 111_320, lon: home.lon, accuracy }));
  record(fixes);
  const end = { lat: home.lat + 4000 / 111_320, lon: home.lon };
  record([5, 10, 15].map((m) => ({ ts: DAY0 + 10 * MIN + m * MIN, ...end })));
  const trip = theTrip(await timeline());
  assert.equal(trip.mode, "driving");
  assert.equal(trip.pathSource, "road");
  assert.ok(trip.path.length > 20, `${trip.path.length} points`);
  assert.equal(osrm.calls.length, 1);
  assert.deepEqual(osrm.calls[0].radiuses.split(";").map(Number), [40, 40, 35], "vague fixes search 40 m around them, not more");
});

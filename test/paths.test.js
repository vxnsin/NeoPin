import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { recordPosition } from "../src/history.js";
import { chunks, pathFromMatch, profileFor } from "../src/paths.js";
import { deviceHeaders, startServer } from "./helpers.js";

const MIN = 60_000;
const DAY = "2025-06-10";
const DAY0 = Date.UTC(2025, 5, 10);
// Snapped points sit this far east of the fixes, about 4 m: easy to tell apart.
const SHIFT = 0.00005;

test("long traces go to OSRM in pieces of at most 100 points that share their ends", () => {
  const points = Array.from({ length: 250 }, (_, i) => i);
  const pieces = chunks(points);
  assert.deepEqual(
    pieces.map((p) => [p[0], p[p.length - 1], p.length]),
    [
      [0, 99, 100],
      [99, 198, 100],
      [198, 249, 52],
    ]
  );
  assert.deepEqual(chunks([1, 2, 3]), [[1, 2, 3]]);
});

test("a match becomes a path: each matching once, a fix where nothing matched between two", () => {
  const points = [0, 1, 2, 3, 4, 5].map((i) => ({ lat: 48 + i / 1000, lon: 11 }));
  const answer = {
    matchings: [{ geometry: { coordinates: [[11.1, 48], [11.1, 48.001]] } }, { geometry: { coordinates: [[11.2, 48.004], [11.2, 48.005]] } }],
    // Point 1 was tidied away inside the first matching, point 3 matched nothing between the two.
    tracepoints: [{ matchings_index: 0 }, null, { matchings_index: 0 }, null, { matchings_index: 1 }, { matchings_index: 1 }],
  };
  assert.deepEqual(pathFromMatch(answer, points), [
    [48, 11.1],
    [48.001, 11.1],
    [48.003, 11],
    [48.004, 11.2],
    [48.005, 11.2],
  ]);
});

test("each mode has its profile, rides without a road keep their fixes", () => {
  assert.equal(profileFor({ mode: "walking" }), "foot");
  assert.equal(profileFor({ mode: "cycling" }), "bike");
  assert.equal(profileFor({ mode: "driving" }), "car");
  assert.equal(profileFor({ mode: "transit", transit: { kind: "bus" } }), "car");
  assert.equal(profileFor({ mode: "transit", transit: { kind: "tram" } }), null);
  assert.equal(profileFor({ mode: "transit", transit: null }), null);
});

// A stand-in for OSRM: snaps every point a little to the east, or answers with `reply`.
function fakeOsrm() {
  const calls = [];
  let reply = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const match = /^\/routed-(\w+)\/match\/v1\/driving\/(.+)$/.exec(url.pathname);
    const coords = match[2].split(";").map((pair) => pair.split(",").map(Number));
    calls.push({ profile: match[1], count: coords.length, timestamps: url.searchParams.get("timestamps"), radiuses: url.searchParams.get("radiuses") });
    res.setHeader("content-type", "application/json");
    if (reply) {
      res.statusCode = reply.status ?? 200;
      return res.end(JSON.stringify(reply.body(coords)));
    }
    res.end(
      JSON.stringify({
        code: "Ok",
        matchings: [{ confidence: 0.9, geometry: { coordinates: coords.map(([lon, lat]) => [lon + SHIFT, lat]) } }],
        tracepoints: coords.map(() => ({ matchings_index: 0 })),
      })
    );
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

let s;
let luis;
let osrm;
beforeEach(async () => {
  s = await startServer();
  luis = await s.account("luis");
  osrm = await fakeOsrm();
  config.roadMatchUrl = osrm.url;
});
afterEach(async () => {
  config.roadMatchUrl = null;
  await osrm.close();
  await s.stop();
});

const record = (fixes) => fixes.forEach((f) => recordPosition(luis.user.id, "phone", f.lat, f.lon, f.ts, { accuracy: f.accuracy ?? null }));

// A stay, then `count` fixes `everyS` apart heading north at `speedMs`, then a stay.
function aDay(count, speedMs = 12, everyS = 5) {
  const home = { lat: 48.1, lon: 11.5 };
  record([0, 5, 10].map((m) => ({ ts: DAY0 + m * MIN, ...home })));
  const step = (speedMs * everyS) / 111_320;
  const fixes = Array.from({ length: count }, (_, i) => ({
    ts: DAY0 + 11 * MIN + (i + 1) * everyS * 1000,
    lat: home.lat + (i + 1) * step,
    lon: home.lon,
    accuracy: 4,
  }));
  record(fixes);
  const last = fixes[fixes.length - 1];
  record([1, 6, 11].map((m) => ({ ts: last.ts + m * MIN, lat: last.lat, lon: last.lon })));
  return fixes;
}

const timeline = async () => {
  const res = await fetch(`${s.baseUrl}/api/timeline?deviceId=phone&date=${DAY}&tz=0`, { headers: deviceHeaders("phone", luis.token) });
  assert.equal(res.status, 200);
  return res.json();
};

const theTrip = (body) => body.segments.find((seg) => seg.type === "trip");

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
    trip.path.slice(1, -1).every(([, lon]) => lon === Math.round((11.5 + SHIFT) * 1e6) / 1e6),
    "in between it follows the road"
  );
  assert.equal(osrm.calls.length, 1);
  assert.equal(osrm.calls[0].profile, "car");
  assert.match(osrm.calls[0].radiuses, /^10;10;/, "radii from the accuracy, clamped to 10 m");
  assert.equal(osrm.calls[0].count, trip.path.length - 2, "the visit centres at both ends are not sent");
  const seconds = osrm.calls[0].timestamps.split(";").map(Number);
  assert.equal(seconds[0], 0, "times are relative to the start, OSRM never learns when the trip was");
  assert.ok(seconds.every((t, i) => i === 0 || t > seconds[i - 1]), "and only go up");
  assert.ok(trip.distanceM > 1000 && trip.distanceM < 1300, "the distance stays the one of the fixes");

  const again = theTrip(await timeline());
  assert.deepEqual(again.path, trip.path);
  assert.equal(osrm.calls.length, 1, "the second load comes from the cache");
});

test("a long drive is matched in pieces of at most 100 points", async () => {
  aDay(230);
  const trip = theTrip(await timeline());
  assert.equal(trip.pathSource, "road");
  assert.equal(osrm.calls.length, 3);
  assert.ok(osrm.calls.every((c) => c.count <= 100));
  assert.ok(trip.path.length >= 220, `${trip.path.length} points`);
});

test("a walk goes to the foot profile", async () => {
  aDay(60, 1.4, 12);
  const trip = theTrip(await timeline());
  assert.equal(trip.mode, "walking");
  assert.equal(osrm.calls[0].profile, "foot");
});

test("a match with a detour the phone never made is not used, and not asked again", async () => {
  osrm.answer({
    body: (coords) => ({
      code: "Ok",
      matchings: [{ geometry: { coordinates: [coords[0], [coords[0][0] + 0.1, coords[0][1]], coords[coords.length - 1]] } }],
      tracepoints: coords.map(() => ({ matchings_index: 0 })),
    }),
  });
  aDay(20);
  const trip = theTrip(await timeline());
  assert.equal(trip.pathSource, undefined);
  assert.ok(trip.path.every(([, lon]) => lon === 11.5), "the fixes themselves");
  await timeline();
  assert.equal(osrm.calls.length, 1);
  assert.equal(getDb().prepare("SELECT path FROM trip_paths").get().path, null);
});

test("no match keeps the fixes, a broken server is tried again later and is not pending", async () => {
  osrm.answer({ body: () => ({ code: "NoMatch", message: "Could not match the trace." }) });
  aDay(20);
  const noMatch = await timeline();
  assert.equal(theTrip(noMatch).pathSource, undefined);
  assert.equal(noMatch.pathsPending, false);

  getDb().prepare("DELETE FROM trip_paths").run();
  osrm.answer({ status: 502, body: () => ({ message: "busy" }) });
  const broken = await timeline();
  assert.equal(theTrip(broken).pathSource, undefined);
  assert.equal(broken.pathsPending, false, "nothing is running anymore");
  await timeline();
  assert.equal(osrm.calls.length, 2, "the failure is not retried right away");
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

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { recordPosition } from "../src/history.js";
import { resetPaths, smoothPaths } from "../src/paths.js";
import { decodeTile, encodeTile, tileBounds, tileOf, tilesAlong, TILE_VERSION, waysFromOverpass } from "../src/roads/fetch.js";
import { deviceHeaders, startServer } from "./helpers.js";

const MIN = 60_000;
const DAY = "2025-06-10";
const DAY0 = Date.UTC(2025, 5, 10);
// The road runs due north this far east of the fixes, about 4 m.
const ROAD_LON = 11.50005;

// A road north from the home of the test day, as Overpass would answer (out body geom), and a
// footpath beside it that cars do not take.
function roadElements() {
  const node = (i) => ({ lat: 48.09 + i * 0.0002, lon: ROAD_LON });
  const road = Array.from({ length: 250 }, (_, i) => node(i));
  return [
    { type: "way", id: 10, nodes: road.map((_, i) => 1000 + i), geometry: road, tags: { highway: "secondary", name: "Hauptstraße", surface: "asphalt" } },
    { type: "way", id: 11, nodes: road.map((_, i) => 5000 + i), geometry: road.map((p) => ({ lat: p.lat, lon: 11.49995 })), tags: { highway: "footway" } },
  ];
}

// A stand-in for Overpass. `hold()` keeps the answers back until the returned function is
// called, `fail(status)` makes it break.
function fakeOverpass() {
  const calls = [];
  let gate = null;
  let failing = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      calls.push({ query: new URLSearchParams(body).get("data"), userAgent: req.headers["user-agent"] });
      if (gate) await gate;
      res.setHeader("content-type", "application/json");
      if (failing) {
        res.statusCode = failing.status ?? 200;
        return res.end(JSON.stringify(failing.body ?? {}));
      }
      res.end(JSON.stringify({ version: 0.6, elements: roadElements() }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/api/interpreter`,
        calls,
        hold() {
          let release;
          gate = new Promise((r) => (release = r));
          return () => {
            gate = null;
            release();
          };
        },
        fail: (next) => (failing = next),
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
      })
    )
  );
}

let s;
let luis;
let overpass;
beforeEach(async () => {
  s = await startServer();
  luis = await s.account("luis");
  overpass = await fakeOverpass();
  config.roadMatch = "own";
  config.roadsSource = "overpass";
  config.roadDataUrl = overpass.url;
});
afterEach(async () => {
  config.roadMatch = "off";
  config.roadsSource = "openfreemap";
  config.roadDataUrl = null;
  await overpass.close();
  await s.stop();
});

const record = (fixes) => fixes.forEach((f) => recordPosition(luis.user.id, "phone", f.lat, f.lon, f.ts, { accuracy: f.accuracy ?? null }));

// A stay, 20 fixes 5 s apart heading north at 12 m/s, a stay.
function aDrive() {
  const home = { lat: 48.1, lon: 11.5 };
  record([0, 5, 10].map((m) => ({ ts: DAY0 + m * MIN, ...home })));
  const step = 60 / 111_320;
  const fixes = Array.from({ length: 20 }, (_, i) => ({ ts: DAY0 + 11 * MIN + (i + 1) * 5000, lat: home.lat + (i + 1) * step, lon: home.lon, accuracy: 6 }));
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
const tileCount = () => Number(getDb().prepare("SELECT COUNT(*) AS n FROM road_tiles").get().n);

test("a drive is matched by the own matcher on OpenStreetMap roads, the tiles are stored", async () => {
  aDrive();
  const body = await timeline();
  assert.equal(body.pathsPending, false);
  const trip = theTrip(body);
  assert.equal(trip.mode, "driving");
  assert.equal(trip.pathSource, "road");
  const [visit] = body.segments;
  assert.deepEqual(trip.path[0], [visit.lat, visit.lon], "still starts at the marker of the visit");
  assert.ok(trip.path.slice(1, -1).every(([, lon]) => Math.abs(lon - ROAD_LON) < 1e-6), "in between on the road, not on the footpath");
  assert.equal(overpass.calls.length, 1, "all tiles of the trip in one query");
  assert.match(overpass.calls[0].query, /way\[highway~"\^\(motorway\|/);
  assert.match(overpass.calls[0].query, /out body geom;/);
  assert.match(overpass.calls[0].userAgent, /^NeoPin\//);
  assert.ok(tileCount() >= 1);

  // The trip comes from the trip cache, the tiles from theirs: nothing is asked again.
  getDb().prepare("DELETE FROM trip_paths").run();
  const again = theTrip(await timeline());
  assert.equal(again.pathSource, "road");
  assert.deepEqual(again.path, trip.path);
  assert.equal(overpass.calls.length, 1);
});

test("while the tiles are loading the paths are pending, then the roads are there", async () => {
  const fixes = aDrive();
  const release = overpass.hold();
  const trip = { type: "trip", mode: "driving", start: fixes[0].ts, end: fixes.at(-1).ts, fixes };
  assert.deepEqual(await smoothPaths(luis.user.id, "phone", [trip], { waitMs: 30 }), { pending: true });
  assert.equal(trip.pathSource, undefined);
  release();
  const later = { ...trip, fixes };
  for (let i = 0; i < 200 && !later.pathSource; i++) {
    await new Promise((r) => setTimeout(r, 20));
    await smoothPaths(luis.user.id, "phone", [later], { waitMs: 30 });
  }
  assert.equal(later.pathSource, "road");
  assert.equal(overpass.calls.length, 1);
});

test("a broken Overpass keeps the fixes, is not pending and not asked again right away", async () => {
  overpass.fail({ status: 504, body: { message: "busy" } });
  aDrive();
  const body = await timeline();
  assert.equal(theTrip(body).pathSource, undefined);
  assert.equal(body.pathsPending, false);
  await timeline();
  assert.equal(overpass.calls.length, 1);
  assert.equal(tileCount(), 0);
});

test("an answer that ran out of time on the server (200 with a runtime error) is a failure, not an empty map", async () => {
  overpass.fail({ status: 200, body: { elements: [], remark: "runtime error: Query timed out in \"query\" at line 3 after 26 seconds." } });
  aDrive();
  assert.equal(theTrip(await timeline()).pathSource, undefined);
  assert.equal(tileCount(), 0, "nothing stored that would look like a place without roads");
});

test("with ROADS=off nothing is asked; stored tiles are still used", async () => {
  aDrive();
  config.roadDataUrl = null;
  assert.equal(theTrip(await timeline()).pathSource, undefined);
  assert.equal(overpass.calls.length, 0);

  // Switched on again (a restart): the trip is tried again right away.
  config.roadDataUrl = overpass.url;
  resetPaths({ spacing: 0 });
  getDb().prepare("DELETE FROM trip_paths").run();
  assert.equal(theTrip(await timeline()).pathSource, "road");
  config.roadDataUrl = null;
  getDb().prepare("DELETE FROM trip_paths").run();
  assert.equal(theTrip(await timeline()).pathSource, "road", "from the stored tiles");
  assert.equal(overpass.calls.length, 1);
});

test("old tiles are used and refreshed in the background, tiles of an older version count as missing", async () => {
  aDrive();
  await timeline();
  assert.equal(overpass.calls.length, 1);
  getDb().prepare("UPDATE road_tiles SET fetched_at = ?").run(Date.now() - 40 * 86_400_000);
  getDb().prepare("DELETE FROM trip_paths").run();
  assert.equal(theTrip(await timeline()).pathSource, "road", "a month-old map is still a map");
  for (let i = 0; i < 300 && overpass.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(overpass.calls.length, 2, "and it is asked for again");
  // The refresh is stored before the next step, or it would overwrite the older version below.
  const stale = () => Number(getDb().prepare("SELECT COUNT(*) AS n FROM road_tiles WHERE fetched_at < ?").get(Date.now() - 86_400_000).n);
  for (let i = 0; i < 300 && stale() > 0; i++) await new Promise((r) => setTimeout(r, 10));

  getDb().prepare("UPDATE road_tiles SET version = ?").run(TILE_VERSION - 1);
  getDb().prepare("DELETE FROM trip_paths").run();
  assert.equal(theTrip(await timeline()).pathSource, "road");
  assert.equal(overpass.calls.length, 3);
});

test("ROAD_MATCH=off snaps nothing", async () => {
  config.roadMatch = "off";
  aDrive();
  const body = await timeline();
  assert.equal(theTrip(body).pathSource, undefined);
  assert.equal(body.pathsPending, false);
  assert.equal(overpass.calls.length, 0);
});

test("tiles: zoom 14 slippy tiles, stretches between sparse fixes are covered too", () => {
  const [x, y] = tileOf(50.25, 11.4);
  assert.deepEqual([x, y], [8710, 5538]);
  const [south, west, north, east] = tileBounds(x, y);
  assert.ok(south < 50.25 && north > 50.25 && west < 11.4 && east > 11.4);
  // Two fixes 6 km apart: the tiles in between belong to the trip as well.
  const tiles = tilesAlong([{ lat: 50.25, lon: 11.3 }, { lat: 50.25, lon: 11.384 }], 100);
  const xs = new Set(tiles.map(([tx]) => tx));
  const [x0] = tileOf(50.25, 11.3);
  const [x1] = tileOf(50.25, 11.384);
  for (let tx = x0; tx <= x1; tx++) assert.ok(xs.has(tx), `tile ${tx}`);
});

test("a tile is stored compactly and comes back the same; only the tags that matter are kept", () => {
  const ways = waysFromOverpass([
    ...roadElements(),
    { type: "node", id: 1, lat: 1, lon: 2 },
    { type: "way", id: 12, nodes: [1, 2], geometry: [{ lat: 48, lon: 11 }, null], tags: { highway: "residential" } },
  ]);
  assert.equal(ways.length, 2, "nodes and ways with holes are left out");
  assert.deepEqual(ways[0].tags, { highway: "secondary" });
  const blob = encodeTile(ways);
  const back = decodeTile(blob);
  assert.deepEqual(back.map((w) => w.nodes), ways.map((w) => w.nodes));
  for (let i = 0; i < ways.length; i++) {
    assert.ok(back[i].lat.every((v, k) => Math.abs(v - ways[i].lat[k]) < 1e-6));
    assert.ok(back[i].lon.every((v, k) => Math.abs(v - ways[i].lon[k]) < 1e-6));
  }
  assert.ok(blob.length < JSON.stringify(roadElements()).length / 5, `${blob.length} bytes`);
});

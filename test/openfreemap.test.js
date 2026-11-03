import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { PbfWriter } from "pbf";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { recordPosition } from "../src/history.js";
import { resetPaths } from "../src/paths.js";
import { decodeTile, encodeTile, tileBounds, tileOf } from "../src/roads/fetch.js";
import { BACKWARD, FORWARD, buildGraph } from "../src/roads/graph.js";
import { clipLine, tagsFromOpenMapTiles, waysFromVectorTile } from "../src/roads/vectorTiles.js";
import { deviceHeaders, startServer } from "./helpers.js";

// ---- a tiny Mapbox Vector Tile encoder (https://github.com/mapbox/vector-tile-spec) ----

const zigzag = (n) => (n << 1) ^ (n >> 31);

// features: [{ type: 2 (line) or 3 (polygon), props: {}, lines: [[[x, y], ...]] }] in tile pixels.
export function encodeMvt(layers) {
  const pbf = new PbfWriter();
  for (const [name, { extent = 4096, features }] of Object.entries(layers)) {
    pbf.writeMessage(3, (layer, w) => {
      w.writeVarintField(15, 2);
      w.writeStringField(1, name);
      const keys = [];
      const values = [];
      const index = (list, v) => (list.includes(v) ? list.indexOf(v) : list.push(v) - 1);
      const encoded = layer.features.map((f) => {
        const tags = [];
        for (const [k, v] of Object.entries(f.props)) tags.push(index(keys, k), index(values, v));
        const geometry = [];
        let cx = 0;
        let cy = 0;
        for (const line of f.lines) {
          line.forEach(([x, y], i) => {
            if (i === 0) geometry.push(1 | (1 << 3));
            else if (i === 1) geometry.push(2 | ((line.length - 1) << 3));
            geometry.push(zigzag(Math.round(x) - cx), zigzag(Math.round(y) - cy));
            cx = Math.round(x);
            cy = Math.round(y);
          });
          if (f.type === 3) geometry.push(7 | (1 << 3));
        }
        return { tags, type: f.type, geometry };
      });
      for (const f of encoded) {
        w.writeMessage(2, (feature, fw) => {
          fw.writePackedVarint(2, feature.tags);
          fw.writeVarintField(3, feature.type);
          fw.writePackedVarint(4, feature.geometry);
        }, f);
      }
      for (const k of keys) w.writeStringField(3, k);
      for (const v of values) {
        w.writeMessage(4, (value, vw) => {
          if (typeof value === "string") vw.writeStringField(1, value);
          else if (Number.isInteger(value)) vw.writeSVarintField(6, value);
          else vw.writeDoubleField(3, value);
        }, v);
      }
      w.writeVarintField(5, extent);
    }, { features });
  }
  return Buffer.from(pbf.finish());
}

// Tile pixels of a spot (zoom 14, extent 4096), relative to tile (x, y).
function pixel(lat, lon, x, y) {
  const n = 2 ** 14 * 4096;
  const rad = (lat * Math.PI) / 180;
  const gx = ((lon + 180) / 360) * n;
  const gy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [gx - x * 4096, gy - y * 4096];
}

test("OpenMapTiles classes become the OSM tags the profiles know", () => {
  assert.deepEqual(tagsFromOpenMapTiles({ class: "primary", oneway: 1 }), { highway: "primary", oneway: "yes" });
  assert.deepEqual(tagsFromOpenMapTiles({ class: "motorway", ramp: 1 }), { highway: "motorway_link" });
  assert.deepEqual(tagsFromOpenMapTiles({ class: "minor", oneway: -1 }), { highway: "residential", oneway: "-1" });
  assert.deepEqual(tagsFromOpenMapTiles({ class: "service", service: "driveway" }), { highway: "service", service: "driveway" });
  assert.deepEqual(tagsFromOpenMapTiles({ class: "path", subclass: "footway", foot: "designated" }), { highway: "footway", foot: "designated" });
  assert.deepEqual(tagsFromOpenMapTiles({ class: "path", subclass: "steps" }), { highway: "steps" });
  assert.deepEqual(tagsFromOpenMapTiles({ class: "trunk", expressway: 1 }), { highway: "trunk", motorroad: "yes" });
  assert.deepEqual(tagsFromOpenMapTiles({ class: "rail", subclass: "tram" }), { railway: "tram" });
  assert.equal(tagsFromOpenMapTiles({ class: "path", subclass: "platform" }), null);
  assert.equal(tagsFromOpenMapTiles({ class: "ferry" }), null);
  assert.equal(tagsFromOpenMapTiles({ class: "pier" }), null);
});

test("a vector tile is decoded: lines cut at the tile's edge, on the world grid, rails apart, areas left out", () => {
  const [x, y] = [8713, 5535];
  const blob = encodeMvt({
    transportation: {
      features: [
        // From the buffer west of the tile into it, then along.
        { type: 2, props: { class: "secondary" }, lines: [[[-64, 1000], [100, 1000], [2000, 1200]]] },
        // Two lines in one feature (OpenMapTiles groups lines with the same attributes).
        { type: 2, props: { class: "path", subclass: "footway" }, lines: [[[10, 10], [20, 20]], [[30, 30], [40, 40]]] },
        { type: 2, props: { class: "rail", subclass: "rail" }, lines: [[[0, 3000], [4096, 3000]]] },
        { type: 3, props: { class: "pier" }, lines: [[[0, 0], [10, 0], [10, 10]]] },
        { type: 2, props: { class: "ferry" }, lines: [[[0, 0], [4000, 4000]]] },
      ],
    },
    water: { features: [{ type: 3, props: { class: "lake" }, lines: [[[0, 0], [5, 0], [5, 5]]] }] },
  });
  const { roads, rail } = waysFromVectorTile(blob, x, y);
  assert.equal(roads.length, 3);
  assert.equal(rail.length, 1);
  const [road] = roads;
  assert.deepEqual(road.tags, { highway: "secondary" });
  assert.equal(road.nodes.length, 3, "cut where it enters the tile");
  const [south, west, north] = tileBounds(x, y);
  assert.ok(Math.abs(road.lon[0] - west) < 1e-9, "the first vertex is on the western edge");
  assert.ok(road.lat[0] < north && road.lat[0] > south);
  // A vertex at pixel (100, 1000) is where the tile grid puts it.
  const [px, py] = pixel(road.lat[1], road.lon[1], x, y);
  assert.ok(Math.abs(px - 100) < 0.01 && Math.abs(py - 1000) < 0.01, `${px}, ${py}`);
  // The same spot in two tiles is the same node.
  const again = waysFromVectorTile(blob, x, y).roads[0];
  assert.deepEqual(again.nodes, road.nodes);
  // Stored like the Overpass tiles, and back the same.
  const back = decodeTile(encodeTile(roads));
  assert.deepEqual(back.map((w) => w.nodes), roads.map((w) => w.nodes));
  // Gzipped as it comes from some servers.
  assert.equal(waysFromVectorTile(zlib.gzipSync(blob), x, y).roads.length, 3);
});

test("clipping keeps what is inside the tile and splits a line that leaves and comes back", () => {
  assert.deepEqual(clipLine([[-10, 50], [10, 50]], 100), [[[0, 50], [10, 50]]]);
  assert.deepEqual(clipLine([[50, 50], [150, 50], [150, 60], [50, 60]], 100), [
    [[50, 50], [100, 50]],
    [[100, 60], [50, 60]],
  ]);
  assert.deepEqual(clipLine([[200, 200], [300, 300]], 100), []);
});

// Two tiles side by side, a road from the western one into the eastern one with the buffer of
// real tiles, so both draw the stretch near the edge.
function twoTiles({ oneway = 0, cutOff = 0 } = {}) {
  const [x, y] = [8713, 5535];
  const props = { class: "minor", ...(oneway ? { oneway } : {}) };
  const west = encodeMvt({ transportation: { features: [{ type: 2, props, lines: [[[3000, 2000], [4096 + 64, 2000 + cutOff]]] }] } });
  const east = encodeMvt({
    transportation: {
      features: [
        { type: 2, props, lines: [[[-64, 2000 + cutOff], [1000, 2000]]] },
        // A side road that ends on the road, where the tile simplified the junction away.
        { type: 2, props: { class: "service" }, lines: [[[500, 2600], [500, 2000.4]]] },
      ],
    },
  });
  return [...waysFromVectorTile(west, x, y).roads, ...waysFromVectorTile(east, x + 1, y).roads];
}

// Vertices that can reach each other, from vertex v.
function reachable(g, v) {
  const seen = new Set([v]);
  const stack = [v];
  while (stack.length) {
    const u = stack.pop();
    for (let k = g.adjStart[u]; k < g.adjStart[u + 1]; k++) {
      if (!seen.has(g.adjTo[k])) {
        seen.add(g.adjTo[k]);
        stack.push(g.adjTo[k]);
      }
    }
  }
  return seen;
}

test("tiles meet at their edge: a road across it is one road, a cut a little off and a junction simplified away are joined", () => {
  const origin = { lat: 50.29, lon: 11.46 };
  const [, west, north, east] = tileBounds(8713, 5535);
  const perPixel = ((east - west) * 111_320 * Math.cos((north * Math.PI) / 180)) / 4096;
  for (const cutOff of [0, 1.5]) {
    const g = buildGraph(twoTiles({ cutOff }), "car", origin);
    const used = new Set([...g.segA, ...g.segB]);
    assert.equal(reachable(g, g.segA[0]).size, used.size, `one network (cut ${cutOff} px off)`);
    // No stretch twice: what each tile draws beyond its edge is cut away.
    const length = g.segLen.reduce((sum, m) => sum + m, 0);
    const expected = (1096 + 1000 + 599.6) * perPixel;
    assert.ok(Math.abs(length - expected) < 3, `${Math.round(length)} m, not ${Math.round(expected)} m`);
  }
});

test("one-way streets keep their direction through the tiles", () => {
  const origin = { lat: 50.29, lon: 11.46 };
  for (const [oneway, dir] of [[1, FORWARD], [-1, BACKWARD]]) {
    const g = buildGraph(twoTiles({ oneway }), "car", origin);
    const road = [...g.segDir.keys()].filter((s) => !g.segLow[s] && Math.abs(g.y[g.segA[s]] - g.y[g.segB[s]]) < 1);
    assert.ok(road.length >= 2);
    for (const s of road) {
      // Drawn from west to east, so FORWARD is eastwards.
      const eastwards = g.x[g.segB[s]] > g.x[g.segA[s]];
      assert.equal(g.segDir[s], eastwards ? dir : dir === FORWARD ? BACKWARD : FORWARD);
    }
    const foot = buildGraph(twoTiles({ oneway }), "foot", origin);
    assert.ok([...foot.segDir].every((d) => d === (FORWARD | BACKWARD)), "walkers both ways");
  }
});

// ---- the server with OpenFreeMap, OSRM standing in ----

const MIN = 60_000;
const DAY = "2025-06-10";
const DAY0 = Date.UTC(2025, 5, 10);
// The road runs due north this far east of the fixes, about 4 m; OSRM answers 8 m east.
const ROAD_LON = 11.50005;
const OSRM_SHIFT = 0.0001;

// A road north from the home of the test day and a footpath beside it, drawn into any tile asked for.
function tileWith(x, y) {
  const line = (lon) => Array.from({ length: 300 }, (_, i) => pixel(48.09 + i * 0.0002, lon, x, y));
  return encodeMvt({
    transportation: {
      features: [
        { type: 2, props: { class: "secondary" }, lines: [line(ROAD_LON)] },
        { type: 2, props: { class: "path", subclass: "footway" }, lines: [line(11.49995)] },
      ],
    },
  });
}

// A stand-in for OpenFreeMap: the TileJSON at /planet, tiles of build `v1` (or what `build` says).
function fakeTiles() {
  const calls = [];
  let gate = null;
  let failing = null;
  let empty = false;
  const state = { build: "v1" };
  const server = http.createServer(async (req, res) => {
    calls.push({ url: req.url, userAgent: req.headers["user-agent"] });
    if (gate) await gate;
    if (req.url === "/planet") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ tilejson: "3.0.0", tiles: [`http://127.0.0.1:${server.address().port}/planet/${state.build}/{z}/{x}/{y}.pbf`] }));
    }
    const m = /^\/planet\/(\w+)\/14\/(\d+)\/(\d+)\.pbf$/.exec(req.url);
    if (failing) {
      res.statusCode = failing;
      return res.end();
    }
    if (!m || m[1] !== state.build) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-type", "application/vnd.mapbox-vector-tile");
    res.end(empty ? encodeMvt({ transportation: { features: [] } }) : tileWith(Number(m[2]), Number(m[3])));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/planet`,
        calls,
        state,
        tileCalls: () => calls.filter((c) => c.url.endsWith(".pbf")).length,
        hold() {
          let release;
          gate = new Promise((r) => (release = r));
          return () => {
            gate = null;
            release();
          };
        },
        fail: (status) => (failing = status),
        noRoads: () => (empty = true),
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
      })
    )
  );
}

// A stand-in for OSRM: every point a little east, or NoMatch.
function fakeOsrm() {
  const calls = [];
  let noMatch = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const coords = url.pathname.split("/").pop().split(";").map((pair) => pair.split(",").map(Number));
    calls.push(coords.length);
    res.setHeader("content-type", "application/json");
    if (noMatch) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ code: "NoMatch" }));
    }
    const road = coords.map(([lon, lat]) => [lon + OSRM_SHIFT, lat]);
    res.end(JSON.stringify({ code: "Ok", matchings: [{ geometry: { coordinates: road } }], tracepoints: coords.map((_, i) => ({ matchings_index: 0, waypoint_index: i })) }));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/routed-{profile}`,
        calls,
        noMatch: () => (noMatch = true),
        close: () => new Promise((done) => server.close(done)),
      })
    )
  );
}

let s;
let luis;
let tiles;
let osrm;
beforeEach(async () => {
  s = await startServer();
  luis = await s.account("luis");
  tiles = await fakeTiles();
  osrm = await fakeOsrm();
  config.roadMatch = "own";
  config.roadsSource = "openfreemap";
  config.roadDataUrl = tiles.url;
  config.roadMatchUrl = osrm.url;
  config.roadMatchFallback = true;
  resetPaths({ spacing: 0, tilesWait: 300 });
});
afterEach(async () => {
  config.roadMatch = "off";
  config.roadDataUrl = null;
  config.roadMatchUrl = null;
  resetPaths({ spacing: 0 });
  await tiles.close();
  await osrm.close();
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
const sources = () => getDb().prepare("SELECT source FROM trip_paths").all().map((r) => r.source);
const inner = (trip) => trip.path.slice(1, -1);
// On the grid of the tiles, about 0.4 m.
const onOwnRoad = (trip) => inner(trip).every(([, lon]) => Math.abs(lon - ROAD_LON) < 5e-6);
const fromOsrm = (trip) => inner(trip).every(([, lon]) => Math.abs(lon - (11.5 + OSRM_SHIFT)) < 1e-5);
const until = async (done) => {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
};

test("a drive is matched on OpenFreeMap tiles: the TileJSON once, a request per tile, roads and rails stored", async () => {
  aDrive();
  const body = await timeline();
  const trip = theTrip(body);
  assert.equal(body.pathsPending, false);
  assert.equal(trip.pathSource, "road");
  assert.ok(onOwnRoad(trip), "on the road, not on the footpath beside it");
  assert.deepEqual(sources(), ["own"]);
  assert.equal(osrm.calls.length, 0, "nobody else saw the trip");
  assert.equal(tiles.calls.filter((c) => c.url === "/planet").length, 1);
  const [x, y] = tileOf(48.1, 11.5);
  assert.ok(tiles.calls.some((c) => c.url === `/planet/v1/14/${x}/${y}.pbf`));
  assert.match(tiles.calls[0].userAgent, /^NeoPin\//);
  const layers = getDb().prepare("SELECT layer, COUNT(*) AS n FROM road_tiles GROUP BY layer").all();
  assert.deepEqual(layers.map((l) => [l.layer, Number(l.n)]), [["rail", tiles.tileCalls()], ["roads", tiles.tileCalls()]]);
});

test("a new planet build: a tile that is gone asks the TileJSON for the new address", async () => {
  aDrive();
  // The TileJSON is read once, then the planet is rebuilt.
  await timeline();
  getDb().prepare("DELETE FROM road_tiles").run();
  getDb().prepare("DELETE FROM trip_paths").run();
  tiles.state.build = "v2";
  const trip = theTrip(await timeline());
  assert.ok(onOwnRoad(trip));
  assert.equal(tiles.calls.filter((c) => c.url === "/planet").length, 2);
  assert.ok(tiles.calls.some((c) => c.url.startsWith("/planet/v2/")));
});

test("while the tiles load OSRM stands in at once; once they are there the own matcher draws the trip", async () => {
  aDrive();
  const release = tiles.hold();
  const body = await timeline();
  assert.equal(body.pathsPending, false, "not waiting for the tiles");
  assert.ok(fromOsrm(theTrip(body)), "OSRM's roads in the meantime");
  assert.deepEqual(sources(), ["fallback"]);
  // Still loading: the stand-in is shown, nobody is asked again.
  const calls = osrm.calls.length;
  assert.ok(fromOsrm(theTrip(await timeline())));
  assert.equal(osrm.calls.length, calls);
  release();
  await until(() => Number(getDb().prepare("SELECT COUNT(*) AS n FROM road_tiles WHERE layer = 'roads'").get().n) >= 1 && tiles.tileCalls() > 0);
  await new Promise((r) => setTimeout(r, 50));
  const later = theTrip(await timeline());
  assert.ok(onOwnRoad(later), "the own roads once the tiles are there");
  assert.deepEqual(sources(), ["own"]);
  assert.equal(osrm.calls.length, calls, "OSRM is not asked again");
});

test("where the own roads fit nothing OSRM is asked, where neither fits the fixes stay", async () => {
  tiles.noRoads();
  const fixes = aDrive();
  const trip = theTrip(await timeline());
  assert.ok(fromOsrm(trip));
  assert.deepEqual(sources(), ["osrm"]);
  // Final: the tiles are there, nothing is matched again.
  const calls = osrm.calls.length;
  await timeline();
  assert.equal(osrm.calls.length, calls);

  getDb().prepare("DELETE FROM trip_paths").run();
  osrm.noMatch();
  const body = await timeline();
  assert.equal(theTrip(body).pathSource, undefined, "the fixes");
  assert.equal(body.pathsPending, false);
  assert.deepEqual(sources(), ["own"]);
  assert.equal(theTrip(body).fixes?.length ?? fixes.length, fixes.length);
});

test("a broken tile server: OSRM stands in, and without a stand-in the fixes stay", async () => {
  tiles.fail(500);
  aDrive();
  assert.ok(fromOsrm(theTrip(await timeline())));
  assert.deepEqual(sources(), ["fallback"]);

  getDb().prepare("DELETE FROM trip_paths").run();
  resetPaths({ spacing: 0, tilesWait: 300 });
  config.roadMatchFallback = false;
  const body = await timeline();
  assert.equal(theTrip(body).pathSource, undefined);
  assert.equal(body.pathsPending, false);
});

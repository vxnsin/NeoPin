import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import zlib from "zlib";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import {
  MAX_PROFILE_POINTS,
  ZOOM,
  climbOf,
  decodePng,
  decodeTerrarium,
  elevationOf,
  elevationStats,
  groundAt,
  resetElevation,
  sampleTile,
  smoothProfile,
  thinProfile,
  tileOf,
} from "../src/elevation.js";
import { distanceM, recordPosition } from "../src/history.js";
import { buildTimeline } from "../src/timeline.js";
import { startServer } from "./helpers.js";

// ---- a tiny PNG encoder, for synthetic Terrarium tiles ----

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// `pixels` row by row, `channels` per pixel; each row uses filter (row % 5) unless one is given.
function encodePng(width, height, channels, pixels, filterOf = (y) => y % 5) {
  const stride = width * channels;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const filter = filterOf(y);
    const line = Buffer.alloc(stride + 1);
    line[0] = filter;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i];
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const corner = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter];
      line[i + 1] = (x - predicted) & 0xff;
    }
    rows.push(line);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = { 3: 2, 4: 6 }[channels];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A Terrarium tile whose height is heightAt(column, row) in metres.
function terrariumTile(heightAt, size = 256) {
  const pixels = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = heightAt(x, y) + 32768;
      const p = (y * size + x) * 3;
      pixels[p] = Math.floor(v / 256);
      pixels[p + 1] = Math.floor(v) % 256;
      pixels[p + 2] = Math.round((v - Math.floor(v)) * 256);
    }
  }
  return encodePng(size, size, 3, pixels);
}

// ---- decoding ----

test("an RGB and an RGBA PNG decode with every filter", () => {
  const width = 7;
  const height = 10;
  for (const channels of [3, 4]) {
    const pixels = Uint8Array.from({ length: width * height * channels }, (_, i) => (i * 37 + (i >> 3) * 11) & 0xff);
    const png = decodePng(encodePng(width, height, channels, pixels));
    assert.equal(png.width, width);
    assert.equal(png.height, height);
    assert.equal(png.channels, channels);
    assert.deepEqual([...png.pixels], [...pixels]);
  }
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /not a PNG/);
});

test("a Terrarium tile gives metres: R * 256 + G + B / 256 - 32768", () => {
  const tile = decodeTerrarium(terrariumTile((x, y) => (x === 0 && y === 0 ? -12.5 : 2962.25), 4));
  assert.equal(tile.width, 4);
  assert.equal(tile.heights[0], -12.5);
  assert.equal(tile.heights[5], 2962.25);
});

// ---- where and between which pixels ----

test("a spot lands on its z12 tile, the pixel offset inside it included", () => {
  assert.deepEqual(tileOf(0, 0), { z: ZOOM, x: 2048, y: 2048, px: 0, py: 0 });
  // Zugspitze, on tile 2172/1433 of zoom 12.
  const peak = tileOf(47.4211, 10.9853);
  assert.equal(peak.x, 2172);
  assert.equal(peak.y, 1433);
  assert.ok(peak.px >= 0 && peak.px < 256 && peak.py >= 0 && peak.py < 256);
});

test("heights are read between the four nearest pixel centres", () => {
  // 2 x 2 pixels standing for a whole tile: each covers 128 x 128 of its 256 px.
  const tile = { width: 2, height: 2, heights: Float32Array.from([0, 10, 20, 30]) };
  assert.equal(sampleTile(tile, 64, 64), 0);
  assert.equal(sampleTile(tile, 192, 64), 10);
  assert.equal(sampleTile(tile, 128, 128), 15);
  assert.equal(sampleTile(tile, 128, 64), 5);
  // Beyond the outer pixel centres the edge holds.
  assert.equal(sampleTile(tile, 0, 0), 0);
  assert.equal(sampleTile(tile, 256, 256), 30);
});

// ---- smoothing and climbing ----

test("ups and downs under 3 m are noise, bigger ones count in full", () => {
  assert.deepEqual(climbOf([100, 101, 102, 101, 100, 102]), { ascent: 0, descent: 0 });
  assert.deepEqual(climbOf([0, 5, 2, 8]), { ascent: 11, descent: 3 });
  // A steady climb counts in steps of the threshold, nearly all of it.
  const steady = Array.from({ length: 101 }, (_, i) => i * 0.5);
  assert.deepEqual(climbOf(steady), { ascent: 48, descent: 0 });
});

test("the profile is averaged over the way and thinned to at most 200 points", () => {
  const smooth = smoothProfile([
    [0, 100],
    [10, 110],
    [20, 100],
    [500, 200],
  ]);
  assert.deepEqual(smooth.map(([d]) => d), [0, 10, 20, 500]);
  assert.ok(Math.abs(smooth[1][1] - 103.33) < 0.01);
  assert.equal(smooth[3][1], 200);
  const long = Array.from({ length: 1000 }, (_, i) => [i, i]);
  const thin = thinProfile(long);
  assert.equal(thin.length, MAX_PROFILE_POINTS);
  assert.deepEqual(thin[0], [0, 0]);
  assert.deepEqual(thin.at(-1), [999, 999]);
});

test("a trip climbs along the ground of its fixes, fixes without ground are skipped", () => {
  // 600 fixes 10 m apart going north, 0.1 m up each, with ±1 m of zigzag noise.
  const fixes = Array.from({ length: 600 }, (_, i) => ({
    ts: i * 5000,
    lat: 47 + (i * 10) / 111_195,
    lon: 11,
    ground: i === 7 ? null : 500 + i * 0.1 + (i % 2 ? 1 : -1),
  }));
  const { ascentM, descentM, elevation } = elevationOf(fixes, distanceM);
  assert.ok(ascentM >= 54 && ascentM <= 60, `ascent ${ascentM}`);
  assert.equal(descentM, 0);
  assert.equal(elevation.length, MAX_PROFILE_POINTS);
  assert.deepEqual(elevation[0], [0, 500]);
  assert.ok(Math.abs(elevation.at(-1)[0] - 5990) <= 2);
  assert.ok(elevation.every(([d, h]) => Number.isInteger(d) && Number.isInteger(h)));
  // Old fixes know no ground: nothing to show.
  assert.deepEqual(
    elevationOf(
      fixes.map(({ ground, ...f }) => f),
      distanceM
    ),
    { ascentM: null, descentM: null, elevation: [] }
  );
});

test("the timeline gives trips their climb and stays their height, null without ground", () => {
  const stay = (from, lat, ground) =>
    Array.from({ length: 12 }, (_, i) => ({ ts: from + i * 60_000, lat, lon: 11, ground }));
  const walk = Array.from({ length: 20 }, (_, i) => ({ ts: 12 * 60_000 + i * 30_000, lat: 47 + (i + 1) * 0.0009, lon: 11, ground: 700 + i * 5 }));
  const points = [...stay(0, 47, 700), ...walk, ...stay(23 * 60_000, 47.0189, 800)];
  const { segments, summary } = buildTimeline(points);
  const [home, trip, top] = segments;
  assert.equal(home.altitudeM, 700);
  assert.equal(top.altitudeM, 800);
  assert.equal(trip.type, "trip");
  assert.ok(trip.ascentM >= 85 && trip.ascentM <= 100, `ascent ${trip.ascentM}`);
  assert.equal(trip.descentM, 0);
  assert.ok(trip.elevation.length >= 2);
  assert.equal(summary.ascentM, trip.ascentM);

  const old = buildTimeline(points.map(({ ground, ...p }) => p));
  assert.equal(old.segments[0].altitudeM, null);
  assert.deepEqual([old.segments[1].ascentM, old.segments[1].descentM, old.segments[1].elevation], [null, null, []]);
  assert.equal(old.summary.ascentM, null);
});

// ---- tiles from a server, cached on disk ----

let s;
let tiles;
let dir;
const saved = {};

// A tile server that counts what it is asked; south is uphill, 2 m a pixel row, across tiles too.
async function tileServer({ failFirst = 0 } = {}) {
  const pngs = new Map();
  const pngOf = (ty) => {
    if (!pngs.has(ty)) pngs.set(ty, terrariumTile((x, y) => 500 + ((ty - 1430) * 256 + y) * 2));
    return pngs.get(ty);
  };
  const seen = [];
  let failures = failFirst;
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, at: Date.now() });
    if (failures-- > 0) {
      res.writeHead(503).end();
      return;
    }
    const ty = Number(req.url.match(/(\d+)\.png$/)[1]);
    res.writeHead(200, { "content-type": "image/png" }).end(pngOf(ty));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/terrarium/{z}/{x}/{y}.png`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withElevation(options = {}) {
  tiles = await tileServer(options);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "neopin-elevation-test-"));
  resetElevation({ spacing: 40, retry: options.retry ?? 60_000 });
  config.elevation = true;
  config.elevationUrl = tiles.url;
  config.elevationDir = dir;
  s = await startServer();
}

beforeEach(() => {
  Object.assign(saved, { elevation: config.elevation, elevationUrl: config.elevationUrl, elevationDir: config.elevationDir, transit: config.transit });
  config.transit = false;
  s = null;
  tiles = null;
});

afterEach(async () => {
  await s?.stop();
  await tiles?.close();
  Object.assign(config, saved);
  resetElevation();
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  dir = null;
});

const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out");
};
const groundOf = () => getDb().prepare("SELECT ground FROM positions ORDER BY ts").all().map((r) => r.ground);
const DAY = Date.UTC(2026, 9, 20, 8);

// A day in the hills: a stay, a walk 1.5 km south (uphill on the test tiles), a stay.
// A phone standing still is stored every 5 minutes.
function seedHike(userId) {
  for (let i = 0; i < 3; i++) recordPosition(userId, "phone", 47.47, 11.1, DAY + i * 5 * 60_000);
  for (let i = 1; i <= 15; i++) recordPosition(userId, "phone", 47.47 - i * 0.0009, 11.1, DAY + 10 * 60_000 + i * 30_000);
  for (let i = 1; i <= 3; i++) recordPosition(userId, "phone", 47.4565, 11.1, DAY + 18 * 60_000 + i * 5 * 60_000);
}

test("a tile is fetched once, kept on disk and fills in the fixes that waited for it", async () => {
  await withElevation();
  const luis = await s.account("luis");
  seedHike(luis.user.id);
  await until(() => groundOf().every((g) => g !== null));
  const asked = tiles.seen.length;
  const { x, y } = tileOf(47.47, 11.1);
  assert.ok(fs.existsSync(path.join(dir, String(ZOOM), String(x), `${y}.png`)));
  assert.ok(asked >= 1 && asked <= 2, `${asked} downloads`);
  // A few a second at most, one after the other.
  for (let i = 1; i < tiles.seen.length; i++) assert.ok(tiles.seen[i].at - tiles.seen[i - 1].at >= 35);

  // From now on straight from the cache, also after a restart (memory gone, disk kept).
  resetElevation({ spacing: 40 });
  assert.equal(typeof groundAt(47.47, 11.1), "number");
  assert.equal(tiles.seen.length, asked);
  assert.equal(elevationStats().downloads, 0);
});

test("the timeline shows the climb, the stays their height and the day its ascent", async () => {
  await withElevation();
  const luis = await s.account("luis");
  seedHike(luis.user.id);
  await until(() => groundOf().every((g) => g !== null));
  const res = await fetch(`${s.baseUrl}/api/timeline?deviceId=phone&date=2026-10-20&tz=0`, { headers: { cookie: luis.cookie } });
  assert.equal(res.status, 200);
  const day = await res.json();
  const [home, trip, top] = day.segments;
  assert.equal(trip.type, "trip");
  assert.ok(trip.ascentM > 50, `ascent ${trip.ascentM}`);
  assert.equal(trip.descentM, 0);
  assert.ok(trip.elevation.length >= 2 && trip.elevation.length <= MAX_PROFILE_POINTS);
  assert.ok(trip.elevation.every((p) => p.length === 2));
  assert.equal(typeof home.altitudeM, "number");
  assert.ok(top.altitudeM > home.altitudeM);
  assert.equal(day.summary.ascentM, trip.ascentM);
});

test("old fixes get their ground once their day is opened, and the review counts it then", async () => {
  await withElevation();
  const luis = await s.account("luis");
  // Fixes from before elevation existed: no ground, and no tile asked for.
  config.elevation = false;
  seedHike(luis.user.id);
  config.elevation = true;
  assert.ok(groundOf().every((g) => g === null));
  assert.equal(tiles.seen.length, 0);

  const review = async () => {
    const res = await fetch(`${s.baseUrl}/api/review?period=week&date=2026-10-20&tz=0`, { headers: { cookie: luis.cookie } });
    assert.equal(res.status, 200);
    return res.json();
  };
  // Opening the week asks for the tiles; what it says until they came has no heights.
  const before = await review();
  assert.equal(before.trips, 1);
  await until(() => groundOf().every((g) => g !== null));
  // The stored day is built again now that its fixes know their ground.
  const after = await review();
  assert.ok(after.ascentM > 50, `ascent ${after.ascentM}`);
  assert.equal(after.highestM.name, null);
  assert.equal(typeof after.highestM.altitudeM, "number");
});

test("a live position gets its height once the tile came, sent to everyone again", async () => {
  await withElevation();
  await s.account("luis");
  const phone = await s.device("luis", "phone");
  await phone.next();
  const viewer = await s.device("luis", "tablet");
  await viewer.next();
  phone.send({ type: "updatePosition", latitude: 47.47, longitude: 11.1, altitude: 999 });
  const placed = await until(async () => {
    const msg = await viewer.next();
    const position = msg.devices?.find((d) => d.deviceId === "phone")?.position;
    return position?.altitude ? position : null;
  });
  // The ground, not what the GPS said.
  assert.equal(placed.altitude, Math.round(groundAt(47.47, 11.1)));
  assert.notEqual(placed.altitude, 999);
});

test("a tile that failed is tried again later, its fixes keep waiting", async () => {
  await withElevation({ failFirst: 1, retry: 200 });
  const luis = await s.account("luis");
  recordPosition(luis.user.id, "phone", 47.47, 11.1, DAY);
  await until(() => tiles.seen.length >= 1);
  assert.deepEqual(groundOf(), [null]);
  await until(() => groundOf()[0] !== null);
  assert.equal(tiles.seen.length, 2);
  assert.ok(tiles.seen[1].at - tiles.seen[0].at >= 190);
});

test("ELEVATION=off asks for nothing and every height is null", async () => {
  await withElevation();
  config.elevation = false;
  const luis = await s.account("luis");
  seedHike(luis.user.id);
  assert.equal(tiles.seen.length, 0);
  // Heights from while it was on do not show either.
  getDb().prepare("UPDATE positions SET ground = 1000").run();
  const res = await fetch(`${s.baseUrl}/api/timeline?deviceId=phone&date=2026-10-20&tz=0`, { headers: { cookie: luis.cookie } });
  const day = await res.json();
  const trip = day.segments.find((seg) => seg.type === "trip");
  assert.deepEqual([trip.ascentM, trip.descentM, trip.elevation], [null, null, []]);
  assert.equal(day.segments[0].altitudeM, null);
  assert.equal(day.summary.ascentM, null);
  assert.equal(groundAt(47.47, 11.1), null);
  const devices = await (await fetch(`${s.baseUrl}/api/getData`, { headers: { cookie: luis.cookie } })).json();
  assert.equal(devices[0].position.altitude, null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(tiles.seen.length, 0);
});

import fs from "fs";
import path from "path";
import zlib from "zlib";
import chalk from "chalk";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { userAgent } from "./overpass.js";

// The height of the ground under a fix. The GPS altitude of a phone wobbles by tens of metres
// and differs between phones, the ground does not: Terrarium tiles of AWS Open Data (Mapzen's
// terrain tiles, SRTM and others) give it for the whole world without a key. A tile of zoom 12
// covers some 6 km by 6 km at a pixel every 25 to 40 m; it is fetched once, kept next to the
// database and read between its four nearest pixels.

export const ZOOM = 12;
const TILE_PX = 256;
const MEMORY_TILES = 64;
const TIMEOUT_MS = 15_000;
const RETRY_MS = 10 * 60_000;

// A few tiles a second at most, one after the other, in the background.
let spacingMs = 500;
let retryMs = RETRY_MS;

// ---- PNG ----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// The pixels of an 8-bit, non-interlaced PNG (grey, RGB, grey with alpha or RGBA), which is what
// tile servers send. Throws on anything else.
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  for (let at = 8; at + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colorType, , , interlace] = body.subarray(8, 13);
      channels = CHANNELS[colorType] ?? 0;
      if (depth !== 8 || !channels || interlace !== 0) throw new Error("unsupported PNG");
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!width || !height || !data.length) throw new Error("incomplete PNG");
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG");
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const up = out - stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[out + i - channels] : 0;
      const above = y > 0 ? pixels[up + i] : 0;
      const corner = y > 0 && i >= channels ? pixels[up + i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += above;
      else if (filter === 3) value += (left + above) >> 1;
      else if (filter === 4) value += paeth(left, above, corner);
      else if (filter !== 0) throw new Error("bad PNG filter");
      pixels[out + i] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// Terrarium: height in metres = R * 256 + G + B / 256 - 32768.
export function decodeTerrarium(buffer) {
  const { width, height, channels, pixels } = decodePng(buffer);
  if (channels < 3) throw new Error("not a Terrarium tile");
  const heights = new Float32Array(width * height);
  for (let i = 0; i < heights.length; i++) {
    const p = i * channels;
    heights[i] = pixels[p] * 256 + pixels[p + 1] + pixels[p + 2] / 256 - 32768;
  }
  return { width, height, heights };
}

// ---- where on which tile ----

// The tile under a spot, and where in it in pixels (0 to 256 from the top left corner).
export function tileOf(lat, lon, z = ZOOM) {
  const n = 2 ** z;
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clamped * Math.PI) / 180;
  const fx = ((((lon + 180) / 360) % 1) + 1) % 1 * n;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const x = Math.min(n - 1, Math.floor(fx));
  const y = Math.min(n - 1, Math.max(0, Math.floor(fy)));
  return { z, x, y, px: (fx - x) * TILE_PX, py: (fy - y) * TILE_PX };
}

// Between the four pixel centres around (px, py); at the border the edge pixels count.
export function sampleTile(tile, px, py) {
  const { width, height, heights } = tile;
  const gx = Math.max(0, Math.min(width - 1, (px * width) / TILE_PX - 0.5));
  const gy = Math.max(0, Math.min(height - 1, (py * height) / TILE_PX - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const at = (x, y) => heights[y * width + x];
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

// ---- the tile store ----

const memory = new Map();
// Tiles still to fetch, by key: the fixes that wait for them (id → [lat, lon]), whether a live
// position asked, and when the last try failed.
const waiting = new Map();
const listeners = new Set();
let started = false;
let running = false;
let retryTimer = null;
let downloads = 0;

export const elevationEnabled = () => config.elevation && !!config.elevationUrl;

const keyOf = (x, y) => `${ZOOM}/${x}/${y}`;
const fileOf = (x, y) => path.join(config.elevationDir, String(ZOOM), String(x), `${y}.png`);
const round1 = (value) => Math.round(value * 10) / 10;

function remember(key, tile) {
  memory.delete(key);
  memory.set(key, tile);
  while (memory.size > MEMORY_TILES) memory.delete(memory.keys().next().value);
}

// A tile that is here already, from memory or from the disk. Null when it still has to be fetched.
function cachedTile(x, y) {
  const key = keyOf(x, y);
  const known = memory.get(key);
  if (known) {
    remember(key, known);
    return known;
  }
  if (waiting.has(key)) return null;
  const file = fileOf(x, y);
  if (!fs.existsSync(file)) return null;
  try {
    const tile = decodeTerrarium(fs.readFileSync(file));
    remember(key, tile);
    return tile;
  } catch {
    // A broken file is fetched again.
    fs.rmSync(file, { force: true });
    return null;
  }
}

function want(x, y, { id = null, lat = 0, lon = 0, live = false } = {}) {
  const key = keyOf(x, y);
  let entry = waiting.get(key);
  if (!entry) {
    entry = { x, y, fixes: new Map(), live: false, failedAt: 0 };
    waiting.set(key, entry);
  }
  if (id !== null) entry.fixes.set(id, [lat, lon]);
  if (live) entry.live = true;
  pump();
}

// The ground at a spot in metres, when its tile is here; otherwise null, and the tile is fetched
// in the background. `live`: the answer is for the map, which is sent again once the tile came.
export function groundAt(lat, lon, { live = false } = {}) {
  if (!elevationEnabled()) return null;
  const at = tileOf(lat, lon);
  const tile = cachedTile(at.x, at.y);
  if (tile) return round1(sampleTile(tile, at.px, at.py));
  want(at.x, at.y, { live });
  return null;
}

// Fills in `ground` of the fixes that have none (with their `id`, as positionsBetween reads
// them): at once where the tile is here, stored too; the rest once their tiles came. So a day
// that is opened gets its heights, also for fixes from before this was switched on.
export function fillGround(points) {
  if (!elevationEnabled()) return 0;
  const found = [];
  let pending = 0;
  for (const p of points) {
    if (p.ground !== null && p.ground !== undefined) continue;
    if (p.id === undefined) continue;
    const at = tileOf(p.lat, p.lon);
    const tile = cachedTile(at.x, at.y);
    if (tile) {
      p.ground = round1(sampleTile(tile, at.px, at.py));
      found.push(p);
    } else {
      want(at.x, at.y, { id: p.id, lat: p.lat, lon: p.lon });
      pending += 1;
    }
  }
  if (found.length) storeGround(found.map((p) => [p.id, p.ground]));
  return pending;
}

function storeGround(rows) {
  try {
    const db = getDb();
    const update = db.prepare("UPDATE positions SET ground = ? WHERE id = ?");
    if (rows.length === 1) return void update.run(rows[0][1], rows[0][0]);
    db.exec("BEGIN");
    try {
      for (const [id, ground] of rows) update.run(ground, id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch {
    // The database went away (a restore, the end of a test): the next opening of the day asks again.
  }
}

// Called with { tile, fixes, live } whenever a tile came in.
export function onGround(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function download(entry) {
  const url = config.elevationUrl.replace("{z}", ZOOM).replace("{x}", entry.x).replace("{y}", entry.y);
  downloads += 1;
  const res = await fetch(url, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const tile = decodeTerrarium(buffer);
  const file = fileOf(entry.x, entry.y);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(`${file}.part`, buffer);
  await fs.promises.rename(`${file}.part`, file);
  return tile;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nextReady(now) {
  for (const [key, entry] of waiting) {
    if (now - entry.failedAt >= retryMs) return [key, entry];
  }
  return null;
}

// One tile after the other, with a pause between them. A failed tile waits a while and is
// tried again, its fixes keep waiting.
function pump() {
  if (!started || running || !elevationEnabled()) return;
  running = true;
  (async () => {
    for (let next = nextReady(Date.now()); next && started; next = nextReady(Date.now())) {
      const [key, entry] = next;
      try {
        const tile = await download(entry);
        remember(key, tile);
        waiting.delete(key);
        const rows = [...entry.fixes].map(([id, [lat, lon]]) => {
          const at = tileOf(lat, lon);
          return [id, round1(sampleTile(tile, at.px, at.py))];
        });
        if (rows.length) storeGround(rows);
        for (const listener of listeners) listener({ tile: key, fixes: rows.length, live: entry.live });
      } catch (error) {
        if (!entry.failedAt) console.log(chalk.yellow(`[!] Elevation tile ${key} could not be loaded: ${error.message}`));
        entry.failedAt = Date.now();
      }
      if (spacingMs) await pause(spacingMs);
    }
    running = false;
    scheduleRetry();
  })();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (!started || !waiting.size) return;
  const earliest = Math.min(...[...waiting.values()].map((e) => e.failedAt));
  retryTimer = setTimeout(pump, Math.max(0, earliest + retryMs - Date.now()));
  retryTimer.unref?.();
}

// The app starts the downloads; before that (and in scripts) lookups only read what is cached.
export function startElevation() {
  started = true;
  pump();
}

export function stopElevation() {
  started = false;
  clearTimeout(retryTimer);
  retryTimer = null;
}

export function elevationStats() {
  return { memory: memory.size, waiting: waiting.size, downloads };
}

export function resetElevation({ spacing = 500, retry = RETRY_MS } = {}) {
  stopElevation();
  memory.clear();
  waiting.clear();
  listeners.clear();
  running = false;
  downloads = 0;
  spacingMs = spacing;
  retryMs = retry;
}

// ---- profiles and climbing ----

// Heights are averaged over this much way on both sides, so a fix that jumps sideways on a
// slope does not climb.
const SMOOTH_M = 50;
// Ups and downs smaller than this are noise and do not count.
export const NOISE_M = 3;
export const MAX_PROFILE_POINTS = 200;

// [distance, height] in metres along a series, averaged over SMOOTH_M on both sides.
export function smoothProfile(samples, windowM = SMOOTH_M) {
  const out = [];
  let from = 0;
  let to = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const d = samples[i][0];
    while (to < samples.length && samples[to][0] <= d + windowM) sum += samples[to++][1];
    while (samples[from][0] < d - windowM) sum -= samples[from++][1];
    out.push([d, sum / (to - from)]);
  }
  return out;
}

// Metres up and down, counted only once a change reaches NOISE_M from the last counted height.
export function climbOf(heights, noise = NOISE_M) {
  let ascent = 0;
  let descent = 0;
  let ref = heights[0];
  for (const h of heights) {
    if (h - ref >= noise) {
      ascent += h - ref;
      ref = h;
    } else if (ref - h >= noise) {
      descent += ref - h;
      ref = h;
    }
  }
  return { ascent, descent };
}

// At most `max` points, evenly spread over the series, first and last included.
export function thinProfile(points, max = MAX_PROFILE_POINTS) {
  if (points.length <= max) return points;
  const out = [];
  for (let k = 0; k < max; k++) out.push(points[Math.round((k * (points.length - 1)) / (max - 1))]);
  return out;
}

// What a trip shows of its heights, from its fixes (in order, `ground` where known) and how to
// measure between two of them: metres up and down, and the profile [[distanceM, altitudeM], …].
// Null and [] without two known heights.
export function elevationOf(fixes, measure) {
  const samples = [];
  let along = 0;
  for (let i = 0; i < fixes.length; i++) {
    if (i) along += measure(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon);
    const ground = fixes[i].ground;
    if (typeof ground === "number" && Number.isFinite(ground)) samples.push([along, ground]);
  }
  if (samples.length < 2) return { ascentM: null, descentM: null, elevation: [] };
  const smooth = smoothProfile(samples);
  const { ascent, descent } = climbOf(smooth.map((s) => s[1]));
  return {
    ascentM: Math.round(ascent),
    descentM: Math.round(descent),
    elevation: thinProfile(smooth).map(([d, h]) => [Math.round(d), Math.round(h)]),
  };
}

// The height of a stay: the middle of its fixes' heights, null when none is known.
export function altitudeOfStay(fixes) {
  const known = fixes.map((f) => f.ground).filter((g) => typeof g === "number" && Number.isFinite(g)).sort((a, b) => a - b);
  if (!known.length) return null;
  const mid = known.length >> 1;
  return Math.round(known.length % 2 ? known[mid] : (known[mid - 1] + known[mid]) / 2);
}

import zlib from "node:zlib";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { askOverpass, userAgent } from "../overpass.js";
import { HIGHWAYS } from "./graph.js";
import { waysFromVectorTile } from "./vectorTiles.js";

// The road network of OpenStreetMap, one map tile at a time (zoom 14, about 1.5 km across in
// Germany): by default from the vector tiles of OpenFreeMap (ROADS_SOURCE=openfreemap, the same
// tiles the map is drawn from, a CDN that answers in a fraction of a second), or from an
// Overpass API (ROADS_SOURCE=overpass). A tile is asked for the first time a trip touches it,
// kept in SQLite and asked again after ROAD_TILE_DAYS. The roads of one trip are a few dozen tiles.

export const TILE_ZOOM = 14;
// Raised when what is stored per tile changes: older tiles count as missing. 2: OpenFreeMap
// tiles, vertices joined by position; the Overpass tiles of version 1 are asked for again.
export const TILE_VERSION = 2;
// A batch of tiles is one Overpass query; public servers often keep a query waiting for half a minute.
const TILES_PER_QUERY = 12;
const TILE_TIMEOUT_MS = 120_000;
// Vector tiles come one request each, a few at a time, from a CDN.
const VECTOR_PARALLEL = 4;
const VECTOR_TIMEOUT_MS = 15_000;
// The address of the tiles changes with every new planet build of OpenFreeMap; the TileJSON says
// where they are and is asked again after this long, or when a tile is not found.
const TILEJSON_MS = 6 * 3_600_000;
// After a failure a tile waits this long, twice as long after each further one, up to MAX_RETRY_MS:
// public Overpass servers ask for exponential backoff when they are full. A CDN is tried sooner.
const RETRY_MS = { overpass: 10 * 60_000, openfreemap: 60_000 };
const MAX_RETRY_MS = 6 * 3_600_000;
// Decoded tiles kept in memory: one long trip, and a few more.
const MEMORY_TILES = 96;

// What each layer asks Overpass for. "rail" is ready for trains and trams to follow their tracks
// between stations later; nothing asks for it yet.
const LAYERS = {
  roads: (bbox) => `way[highway~"^(${HIGHWAYS.join("|")})$"][area!=yes](${bbox});`,
  rail: (bbox) => `way[railway~"^(rail|light_rail|tram|subway|narrow_gauge)$"](${bbox});`,
};

// Only these tags matter to the profiles (graph.js); the rest is not stored.
const KEEP_TAGS = new Set([
  "highway", "railway", "oneway", "oneway:bicycle", "junction", "access", "vehicle", "motor_vehicle", "motorcar",
  "bicycle", "foot", "cycleway", "motorroad", "area", "service",
]);

let spacingMs = 1_000;
let queue = Promise.resolve();
let vectorRunning = 0;
const vectorWaiting = [];
let template = null;
const inFlight = new Map();
const failedAt = new Map();
const memory = new Map();

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const tileKey = (layer, x, y) => `${layer}/${TILE_ZOOM}/${x}/${y}`;

export function tileOf(lat, lon, z = TILE_ZOOM) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

// [south, west, north, east] of a tile.
export function tileBounds(x, y, z = TILE_ZOOM) {
  const n = 2 ** z;
  const lat = (k) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * k) / n))) * 180) / Math.PI;
  return [lat(y + 1), (x / n) * 360 - 180, lat(y), ((x + 1) / n) * 360 - 180];
}

// Every tile within marginM of the line through the points, the stretches between them included:
// the roads between two sparse fixes may run through a tile no fix is in.
export function tilesAlong(points, marginM = 250) {
  const out = new Map();
  const add = (lat, lon) => {
    const dLat = marginM / 111_320;
    const dLon = marginM / (111_320 * Math.cos((lat * Math.PI) / 180));
    const [x0, y1] = tileOf(lat - dLat, lon - dLon);
    const [x1, y0] = tileOf(lat + dLat, lon + dLon);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.set(`${x}/${y}`, [x, y]);
  };
  points.forEach((p, i) => {
    add(p.lat, p.lon);
    if (!i) return;
    const q = points[i - 1];
    const km = Math.hypot((p.lat - q.lat) * 111.32, (p.lon - q.lon) * 111.32 * Math.cos((p.lat * Math.PI) / 180));
    const steps = Math.floor((km * 1000) / marginM);
    for (let k = 1; k < steps; k++) add(q.lat + ((p.lat - q.lat) * k) / steps, q.lon + ((p.lon - q.lon) * k) / steps);
  });
  return [...out.values()];
}

// ---- storage: ways with their node ids and coordinates, delta-coded, deflated ----

export function encodeTile(ways) {
  const rows = ways.map((w) => {
    const delta = (values, scale) => values.map((v, i) => Math.round(v * scale) - (i ? Math.round(values[i - 1] * scale) : 0));
    return [w.id, w.tags, delta(w.nodes, 1), delta(w.lat, 1e6), delta(w.lon, 1e6)];
  });
  return zlib.deflateRawSync(JSON.stringify({ v: TILE_VERSION, w: rows }));
}

export function decodeTile(blob) {
  const { w } = JSON.parse(zlib.inflateRawSync(blob).toString("utf8"));
  const undelta = (values, scale) => {
    let acc = 0;
    return values.map((v) => (acc += v) / scale);
  };
  return w.map(([id, tags, nodes, lat, lon]) => ({ id, tags, nodes: undelta(nodes, 1), lat: undelta(lat, 1e6), lon: undelta(lon, 1e6) }));
}

// Overpass elements (out body geom) into ways.
export function waysFromOverpass(elements = []) {
  const ways = [];
  for (const el of elements) {
    if (el.type !== "way" || !Array.isArray(el.nodes) || !Array.isArray(el.geometry)) continue;
    if (el.nodes.length < 2 || el.nodes.length !== el.geometry.length || el.geometry.some((g) => !g)) continue;
    const tags = {};
    for (const [k, v] of Object.entries(el.tags ?? {})) if (KEEP_TAGS.has(k)) tags[k] = v;
    ways.push({ id: el.id, tags, nodes: el.nodes, lat: el.geometry.map((g) => g.lat), lon: el.geometry.map((g) => g.lon) });
  }
  return ways;
}

const maxAgeMs = () => (config.roadTileDays ?? 30) * 86_400_000;

function remember(key, ways) {
  memory.delete(key);
  memory.set(key, ways);
  while (memory.size > MEMORY_TILES) memory.delete(memory.keys().next().value);
}

// A tile's ways from memory or SQLite: { ways, stale } or null when it is not stored (or from an
// older version).
export function storedTile(layer, x, y) {
  const key = tileKey(layer, x, y);
  const db = getDb();
  const where = "FROM road_tiles WHERE layer = ? AND z = ? AND x = ? AND y = ?";
  const row = db.prepare(`SELECT fetched_at, version ${where}`).get(layer, TILE_ZOOM, x, y);
  if (!row || Number(row.version) !== TILE_VERSION) return null;
  const stale = Date.now() - Number(row.fetched_at) > maxAgeMs();
  let ways = memory.get(key);
  if (!ways) {
    try {
      ways = decodeTile(db.prepare(`SELECT data ${where}`).get(layer, TILE_ZOOM, x, y).data);
    } catch {
      return null;
    }
  }
  remember(key, ways);
  return { ways, stale };
}

// One query for several tiles: a public Overpass takes about as long for one as for a dozen,
// most of the time is waiting for a slot.
function overpassQuery(layer, tiles) {
  const parts = tiles.map(([x, y]) => LAYERS[layer](tileBounds(x, y).map((v) => v.toFixed(6)).join(",")));
  return `[out:json][timeout:${Math.round(TILE_TIMEOUT_MS / 1000) - 10}];\n(\n${parts.join("\n")}\n);\nout body geom;`;
}

// Which of the tiles a way crosses (its bounding box does, close enough).
function tilesOfWay(way, tiles) {
  const s = Math.min(...way.lat), n = Math.max(...way.lat), w = Math.min(...way.lon), e = Math.max(...way.lon);
  return tiles.filter(([x, y]) => {
    const [ts, tw, tn, te] = tileBounds(x, y);
    return s <= tn && n >= ts && w <= te && e >= tw;
  });
}

function storeTile(layer, x, y, ways, now = Date.now()) {
  getDb()
    .prepare("INSERT OR REPLACE INTO road_tiles (layer, z, x, y, fetched_at, version, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(layer, TILE_ZOOM, x, y, now, TILE_VERSION, encodeTile(ways));
  const key = tileKey(layer, x, y);
  remember(key, ways);
  failedAt.delete(key);
}

// Asks Overpass for a batch of tiles, one batch at a time with a pause in between, and stores
// each tile.
function overpassBatch(layer, tiles) {
  const run = queue.then(async () => {
    const elements = await askOverpass(overpassQuery(layer, tiles), { url: config.roadDataUrl, timeoutMs: TILE_TIMEOUT_MS });
    const perTile = new Map(tiles.map(([x, y]) => [tileKey(layer, x, y), []]));
    for (const way of waysFromOverpass(elements)) for (const [x, y] of tilesOfWay(way, tiles)) perTile.get(tileKey(layer, x, y)).push(way);
    const now = Date.now();
    for (const [x, y] of tiles) storeTile(layer, x, y, perTile.get(tileKey(layer, x, y)), now);
  });
  queue = run.catch(() => {}).then(() => pause(spacingMs));
  return run;
}

const isTemplate = (url) => /\{z\}/.test(url);

// Where the vector tiles are, a URL with {z}, {x} and {y}: ROADS_URL itself when it is one,
// else the first of the TileJSON it points at. Tiles asked for at the same time share one
// request for it; `outdated` (an address that led to a missing tile) asks for it again, once.
function tileTemplate(outdated = null) {
  const url = config.roadDataUrl;
  if (isTemplate(url)) return Promise.resolve(url);
  const known = template?.url === url && Date.now() - template.at < TILEJSON_MS && (!outdated || template.tiles !== outdated);
  if (known) return template.promise;
  const entry = { url, at: Date.now(), tiles: null };
  entry.promise = (async () => {
    const res = await fetch(url, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(VECTOR_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Road tiles: the TileJSON answered ${res.status}`);
    const tiles = (await res.json().catch(() => null))?.tiles?.[0];
    if (typeof tiles !== "string" || !isTemplate(tiles)) throw new Error("Road tiles: the TileJSON names no tiles");
    entry.tiles = tiles;
    return tiles;
  })();
  // A failed request is not kept: the next tile asks again.
  entry.promise.catch(() => template === entry && (template = null));
  template = entry;
  return entry.promise;
}

async function vectorTile(x, y, retried = false) {
  const tiles = await tileTemplate();
  const url = tiles.replace("{z}", TILE_ZOOM).replace("{x}", x).replace("{y}", y);
  const res = await fetch(url, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(VECTOR_TIMEOUT_MS) });
  // A planet build that is gone: once more with the address the TileJSON names now.
  if (res.status === 404 && !retried && !isTemplate(config.roadDataUrl)) {
    await tileTemplate(tiles);
    return vectorTile(x, y, true);
  }
  // No content: nothing mapped there, the sea.
  if (res.status === 204) return Buffer.alloc(0);
  if (!res.ok) throw new Error(`Road tiles answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// A few vector tiles at a time.
function limited(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      vectorRunning++;
      task()
        .then(resolve, reject)
        .finally(() => {
          vectorRunning--;
          vectorWaiting.shift()?.();
        });
    };
    if (vectorRunning < VECTOR_PARALLEL) start();
    else vectorWaiting.push(start);
  });
}

// One vector tile, decoded and stored: its roads and its rails, whichever layer was asked for.
function vectorBatch(layer, [[x, y]]) {
  return limited(async () => {
    const ways = waysFromVectorTile(await vectorTile(x, y), x, y, TILE_ZOOM);
    const now = Date.now();
    for (const [name, list] of Object.entries(ways)) storeTile(name, x, y, list, now);
  });
}

// One request for some tiles, kept track of: whoever asks for one of them meanwhile waits for
// the same request, a failure holds them back for a while.
function fetchBatch(layer, tiles) {
  const run = (config.roadsSource === "overpass" ? overpassBatch : vectorBatch)(layer, tiles);
  const settled = run
    .catch((error) => {
      for (const [x, y] of tiles) {
        const key = tileKey(layer, x, y);
        failedAt.set(key, { at: Date.now(), count: (failedAt.get(key)?.count ?? 0) + 1 });
      }
      throw error;
    })
    .finally(() => tiles.forEach(([x, y]) => inFlight.delete(tileKey(layer, x, y))));
  for (const [x, y] of tiles) inFlight.set(tileKey(layer, x, y), settled);
  // Whoever waits on it handles the error; nobody waiting is no unhandled rejection.
  settled.catch(() => {});
  return settled;
}

// Gets the tiles that are not being asked for already, in batches.
function fetchTiles(layer, tiles) {
  const fresh = tiles.filter(([x, y]) => !inFlight.has(tileKey(layer, x, y)));
  const size = config.roadsSource === "overpass" ? TILES_PER_QUERY : 1;
  for (let i = 0; i < fresh.length; i += size) fetchBatch(layer, fresh.slice(i, i + size));
  return Promise.all(tiles.map(([x, y]) => inFlight.get(tileKey(layer, x, y))));
}

export const roadDataEnabled = () => Boolean(config.roadDataUrl);
function failedRecently(layer, [x, y]) {
  const failed = failedAt.get(tileKey(layer, x, y));
  const base = RETRY_MS[config.roadsSource] ?? RETRY_MS.overpass;
  return Boolean(failed) && Date.now() - failed.at < Math.min(MAX_RETRY_MS, base * 2 ** (failed.count - 1));
}

// Whether every one of these tiles is stored (an old one too), without reading them.
export function haveTiles(layer, tiles) {
  const row = getDb().prepare("SELECT version FROM road_tiles WHERE layer = ? AND z = ? AND x = ? AND y = ?");
  return tiles.every(([x, y]) => Number(row.get(layer, TILE_ZOOM, x, y)?.version) === TILE_VERSION);
}

// The ways of all these tiles. Missing ones are asked for first; a tile that failed a moment
// ago fails the whole call until its retry time, so the trip is tried again later. Stale tiles are
// used as they are and refreshed in the background.
export async function waysOfTiles(layer, tiles) {
  const found = [];
  const missing = [];
  const stale = [];
  for (const tile of tiles) {
    const stored = storedTile(layer, tile[0], tile[1]);
    if (stored) {
      found.push(stored.ways);
      if (stored.stale && !failedRecently(layer, tile)) stale.push(tile);
    } else missing.push(tile);
  }
  if (stale.length && roadDataEnabled()) fetchTiles(layer, stale).catch(() => {});
  if (missing.length) {
    if (!roadDataEnabled()) throw new Error("Road data is turned off (ROADS=off)");
    if (missing.some((tile) => failedRecently(layer, tile))) throw new Error("Road tiles failed recently");
    await fetchTiles(layer, missing);
    for (const [x, y] of missing) found.push(storedTile(layer, x, y)?.ways ?? []);
  }
  const ways = [];
  for (const list of found) for (const w of list) ways.push(w);
  return ways;
}

// Asks for every tile of a trip that is not stored yet, all batches queued at once, and waits
// for them. Throws like waysOfTiles.
export async function ensureTiles(layer, tiles) {
  const missing = tiles.filter((tile) => !haveTiles(layer, [tile]));
  if (!missing.length) return;
  if (!roadDataEnabled()) throw new Error("Road data is turned off (ROADS=off)");
  if (missing.some((tile) => failedRecently(layer, tile))) throw new Error("Road tiles failed recently");
  await fetchTiles(layer, missing);
}

export function resetRoadTiles({ spacing = 1_000 } = {}) {
  spacingMs = spacing;
  queue = Promise.resolve();
  vectorRunning = 0;
  vectorWaiting.length = 0;
  template = null;
  inFlight.clear();
  failedAt.clear();
  memory.clear();
}

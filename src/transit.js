import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import chalk from "chalk";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { gtfsSeconds, parseCsvLine, readTable, zipEntries } from "./gtfs.js";

// Bus, tram and train lines for the timeline come from GTFS timetables. Nobody keeps the
// timetables of the whole world: the server holds the Mobility Database catalog (which
// feeds exist and which rectangle on the map each covers), looks where its users have been
// in the last 90 days (cells of about TRANSIT_REGION_KM) and downloads the feeds that cover
// those cells. Of each feed only the slice inside the cell goes into SQLite, once a week.

export const REFRESH_MS = 7 * 86_400_000;
export const ACTIVE_DAYS = 90;
// Stops a little outside the cell still matter: a ride starts inside and ends just beyond.
const MARGIN_KM = 5;
// A cell counts once this many fixes were stored in it, a single stray fix is no region.
const MIN_CELL_FIXES = 5;
const MAX_FEEDS_PER_CELL = 8;
// Catalog rectangles wider than this are mistakes or world-wide aggregators: they would cover every cell.
const MAX_BBOX_DEG = { lat: 45, lon: 90 };
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const CATALOG_TIMEOUT_MS = 60_000;
// Rows per transaction while storing a slice, so recording positions never waits long.
const BATCH = 20_000;
const KM_PER_DEG = 111.32;

// Feeds that cover a whole country better than the pieces in the catalog. A cell inside
// their rectangle gets them, plus the catalog feeds of other countries (for border cells).
export const PREFERRED_FEEDS = [
  {
    source: "preferred:DE",
    country: "DE",
    name: "Germany (gtfs.de, DELFI)",
    provider: "gtfs.de",
    url: "https://download.gtfs.de/germany/free/latest.zip",
    latestUrl: null,
    license: "CC BY 4.0, https://gtfs.de",
    bbox: { minLat: 47.2, maxLat: 55.1, minLon: 5.8, maxLon: 15.1 },
  },
];

const log = (message) => console.log(chalk.cyan(`[i] Transit: ${message}`));
const warn = (message) => console.log(chalk.yellow(`[!] Transit: ${message}`));

// ---- regions ----

const cosLat = (lat) => Math.max(0.1, Math.cos((lat * Math.PI) / 180));
const cellDeg = () => config.transitRegionKm / KM_PER_DEG;

// Cells are squares of about TRANSIT_REGION_KM, named by their centre: "49.735,9.956".
export function cellOf(lat, lon) {
  const dLat = cellDeg();
  const centreLat = (Math.floor(lat / dLat) + 0.5) * dLat;
  const dLon = dLat / cosLat(centreLat);
  const centreLon = (Math.floor(lon / dLon) + 0.5) * dLon;
  return `${centreLat.toFixed(3)},${centreLon.toFixed(3)}`;
}

export function cellBounds(cell, marginKm = 0) {
  const [lat, lon] = cell.split(",").map(Number);
  const halfLat = cellDeg() / 2 + marginKm / KM_PER_DEG;
  const halfLon = halfLat / cosLat(lat);
  return { minLat: lat - halfLat, maxLat: lat + halfLat, minLon: lon - halfLon, maxLon: lon + halfLon };
}

const inside = (b, lat, lon) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;

// The cells with enough fixes of anyone in the last ACTIVE_DAYS. Counted per 0.01 degrees
// in SQL, so a year of history is a few hundred rows, not millions.
export function activeCells(now = Date.now()) {
  const rows = getDb()
    .prepare("SELECT ROUND(lat, 2) AS lat, ROUND(lon, 2) AS lon, COUNT(*) AS n FROM positions WHERE ts >= ? GROUP BY 1, 2")
    .all(now - ACTIVE_DAYS * 86_400_000);
  const counts = new Map();
  for (const row of rows) {
    const cell = cellOf(row.lat, row.lon);
    counts.set(cell, (counts.get(cell) ?? 0) + Number(row.n));
  }
  return [...counts]
    .filter(([, n]) => n >= MIN_CELL_FIXES)
    .map(([cell]) => cell)
    .sort();
}

// ---- the catalog ----

const userAgent = () => `NeoPin/${config.version} (self-hosted location sharing)`;

async function fileAge(file) {
  try {
    return Date.now() - (await fs.promises.stat(file)).mtimeMs;
  } catch {
    return Infinity;
  }
}

async function download(url, file, timeoutMs) {
  const res = await fetch(url, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}`);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
  await fs.promises.rename(part, file);
}

const hex = (value) => (/^[0-9a-f]{6}$/i.test(value ?? "") ? `#${value.toLowerCase()}` : null);

// The catalog rows that can be used: GTFS schedules, free to download, with a sane rectangle.
export function parseCatalog(csv) {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const c = {
    id: col("mdb_source_id"),
    type: col("data_type"),
    country: col("location.country_code"),
    provider: col("provider"),
    name: col("name"),
    url: col("urls.direct_download"),
    auth: col("urls.authentication_type"),
    latest: col("urls.latest"),
    license: col("urls.license"),
    minLat: col("location.bounding_box.minimum_latitude"),
    maxLat: col("location.bounding_box.maximum_latitude"),
    minLon: col("location.bounding_box.minimum_longitude"),
    maxLon: col("location.bounding_box.maximum_longitude"),
    status: col("status"),
    redirect: col("redirect.id"),
  };
  const feeds = [];
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    if (f[c.type] !== "gtfs" || f[c.redirect]) continue;
    if (f[c.status] && f[c.status] !== "active") continue;
    // 1 and 2 need an API key or a login.
    if (f[c.auth] && f[c.auth] !== "0") continue;
    const url = f[c.url] || f[c.latest];
    if (!url) continue;
    const bbox = { minLat: Number(f[c.minLat]), maxLat: Number(f[c.maxLat]), minLon: Number(f[c.minLon]), maxLon: Number(f[c.maxLon]) };
    if (!Object.values(bbox).every(Number.isFinite)) continue;
    if (bbox.maxLat - bbox.minLat > MAX_BBOX_DEG.lat || bbox.maxLon - bbox.minLon > MAX_BBOX_DEG.lon) continue;
    feeds.push({
      source: `mdb:${f[c.id]}`,
      country: f[c.country] || null,
      name: f[c.name] || f[c.provider] || `Feed ${f[c.id]}`,
      provider: f[c.provider] || null,
      url,
      // The Mobility Database keeps a copy, asked when the provider's download fails.
      latestUrl: f[c.latest] && f[c.latest] !== url ? f[c.latest] : null,
      license: f[c.license] || null,
      bbox,
    });
  }
  return feeds;
}

const catalogFile = () => path.join(config.transitDir, "catalog.csv");

async function loadCatalog(force) {
  const file = catalogFile();
  if (force || (await fileAge(file)) > REFRESH_MS) {
    try {
      await download(config.transitCatalogUrl, file, CATALOG_TIMEOUT_MS);
    } catch (error) {
      // An old catalog is better than none.
      if ((await fileAge(file)) === Infinity) throw error;
      warn(`catalog not refreshed, using the old one: ${error.message}`);
    }
  }
  return parseCatalog(await fs.promises.readFile(file, "utf8"));
}

const area = (b) => (b.maxLat - b.minLat) * (b.maxLon - b.minLon);

// Which feeds a cell gets: the preferred country feeds covering it, plus the catalog feeds
// of other countries covering its centre, the ones with the widest reach first.
export function feedsForCell(cell, catalog, preferred = PREFERRED_FEEDS) {
  const [lat, lon] = cell.split(",").map(Number);
  const own = preferred.filter((f) => inside(f.bbox, lat, lon));
  const countries = new Set(own.map((f) => f.country));
  const rest = catalog.filter((f) => inside(f.bbox, lat, lon) && !countries.has(f.country)).sort((a, b) => area(b.bbox) - area(a.bbox));
  return [...own, ...rest].slice(0, MAX_FEEDS_PER_CELL);
}

// ---- feeds ----

const feedFile = (feed) => path.join(config.transitDir, `${feed.source.replace(/[^a-z0-9]+/gi, "-")}.zip`);

// The feed's ZIP on disk, downloaded unless a copy younger than a week is there.
async function ensureFeedFile(feed, force) {
  const file = feedFile(feed);
  if (!force && (await fileAge(file)) < REFRESH_MS) return file;
  try {
    await download(feed.url, file, DOWNLOAD_TIMEOUT_MS);
  } catch (error) {
    if (!feed.latestUrl) throw error;
    await download(feed.latestUrl, file, DOWNLOAD_TIMEOUT_MS);
  }
  return file;
}

// The part of a feed that touches the cell: its stops, every trip calling at them with the
// times at those stops, the routes of those trips, their agencies and shapes. Read into
// memory first, so the database is written in one go afterwards.
export async function readSlice(file, bounds) {
  const entries = await zipEntries(file);
  const stops = new Map();
  await readTable(file, entries, "stops.txt", (col) => {
    const [id, name, lat, lon] = ["stop_id", "stop_name", "stop_lat", "stop_lon"].map(col);
    return (f) => {
      const la = Number(f[lat]);
      const lo = Number(f[lon]);
      if (!f[id] || !Number.isFinite(la) || !Number.isFinite(lo) || !inside(bounds, la, lo)) return;
      stops.set(f[id], { id: f[id], name: f[name] || f[id], lat: la, lon: lo });
    };
  });

  const stopTimes = [];
  const tripIds = new Set();
  await readTable(file, entries, "stop_times.txt", (col) => {
    const [trip, stop, seq, departure, arrival] = ["trip_id", "stop_id", "stop_sequence", "departure_time", "arrival_time"].map(col);
    return (f) => {
      if (!stops.has(f[stop])) return;
      tripIds.add(f[trip]);
      stopTimes.push([f[trip], f[stop], Number(f[seq]) || 0, gtfsSeconds(f[departure] || f[arrival])]);
    };
  });

  const trips = new Map();
  const routeIds = new Set();
  const shapeIds = new Set();
  await readTable(file, entries, "trips.txt", (col) => {
    const [id, route, headsign, shape] = ["trip_id", "route_id", "trip_headsign", "shape_id"].map(col);
    return (f) => {
      if (!tripIds.has(f[id])) return;
      trips.set(f[id], { id: f[id], routeId: f[route], headsign: f[headsign] || null, shapeId: f[shape] || null });
      routeIds.add(f[route]);
      if (f[shape]) shapeIds.add(f[shape]);
    };
  });

  const agencies = new Map();
  await readTable(file, entries, "agency.txt", (col) => {
    const [id, name, timezone] = ["agency_id", "agency_name", "agency_timezone"].map(col);
    return (f) => agencies.set(f[id] ?? "", { name: f[name] || null, timezone: f[timezone] || null });
  });

  const routes = new Map();
  await readTable(file, entries, "routes.txt", (col) => {
    const [id, agency, short, long, type, color, textColor] = [
      "route_id",
      "agency_id",
      "route_short_name",
      "route_long_name",
      "route_type",
      "route_color",
      "route_text_color",
    ].map(col);
    return (f) => {
      if (!routeIds.has(f[id])) return;
      // A feed with one agency may leave agency_id out everywhere.
      const a = agencies.get(f[agency] ?? "") ?? agencies.values().next().value ?? {};
      routes.set(f[id], {
        id: f[id],
        shortName: f[short] || null,
        longName: f[long] || null,
        type: Number(f[type]) || 0,
        color: hex(f[color]),
        textColor: hex(f[textColor]),
        agency: a.name ?? null,
        timezone: a.timezone ?? null,
      });
    };
  });

  const shapes = [];
  await readTable(file, entries, "shapes.txt", (col) => {
    const [id, lat, lon, seq] = ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"].map(col);
    return (f) => {
      if (!shapeIds.has(f[id])) return;
      shapes.push([f[id], Number(f[seq]) || 0, Number(f[lat]), Number(f[lon])]);
    };
  });

  // Stops nothing calls at and stop times of trips the feed does not describe are noise.
  const used = new Set(stopTimes.filter((st) => trips.has(st[0])).map((st) => st[1]));
  return {
    stops: [...stops.values()].filter((s) => used.has(s.id)),
    stopTimes: stopTimes.filter((st) => trips.has(st[0])),
    trips: [...trips.values()],
    routes: [...routes.values()],
    shapes,
  };
}

// Writes a slice under its feed row, in batches so recording positions never waits long.
// Readers may see a feed half filled for a moment, which costs at most one missed match.
function storeSlice(feedId, slice) {
  const db = getDb();
  const batches = (statement, rows, bind) => {
    for (let i = 0; i < rows.length; i += BATCH) {
      db.exec("BEGIN");
      try {
        for (const row of rows.slice(i, i + BATCH)) statement.run(...bind(row));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
  for (const table of ["transit_stop_times", "transit_shapes", "transit_trips", "transit_routes", "transit_stops"]) {
    db.prepare(`DELETE FROM ${table} WHERE feed_id = ?`).run(feedId);
  }
  batches(db.prepare("INSERT INTO transit_stops (feed_id, id, name, lat, lon) VALUES (?, ?, ?, ?, ?)"), slice.stops, (s) => [feedId, s.id, s.name, s.lat, s.lon]);
  batches(
    db.prepare(
      "INSERT INTO transit_routes (feed_id, id, short_name, long_name, type, color, text_color, agency, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    slice.routes,
    (r) => [feedId, r.id, r.shortName, r.longName, r.type, r.color, r.textColor, r.agency, r.timezone]
  );
  batches(db.prepare("INSERT INTO transit_trips (feed_id, id, route_id, headsign, shape_id) VALUES (?, ?, ?, ?, ?)"), slice.trips, (t) => [
    feedId,
    t.id,
    t.routeId,
    t.headsign,
    t.shapeId,
  ]);
  batches(
    db.prepare("INSERT OR REPLACE INTO transit_stop_times (feed_id, trip_id, stop_id, seq, departure) VALUES (?, ?, ?, ?, ?)"),
    slice.stopTimes,
    (st) => [feedId, ...st]
  );
  batches(db.prepare("INSERT OR REPLACE INTO transit_shapes (feed_id, id, seq, lat, lon) VALUES (?, ?, ?, ?, ?)"), slice.shapes, (s) => [feedId, ...s]);
}

// ---- refresh ----

let running = null;

// Looks at the regions, drops the ones nobody has been in for 90 days, and gives every
// other one the feeds that cover it, each imported again once it is a week old. One run at
// a time, a second call joins the one in progress.
export function refreshTransit(options = {}) {
  if (!running) running = runRefresh(options).finally(() => (running = null));
  return running;
}

async function runRefresh({ now = Date.now(), force = false, preferred = PREFERRED_FEEDS } = {}) {
  const result = { regions: 0, imported: 0, failed: 0 };
  if (!config.transit) return result;
  const db = getDb();
  const cells = activeCells(now);
  result.regions = cells.length;
  for (const { cell } of db.prepare("SELECT cell FROM transit_regions").all()) {
    if (cells.includes(cell)) continue;
    db.prepare("DELETE FROM transit_feeds WHERE cell = ?").run(cell);
    db.prepare("DELETE FROM transit_regions WHERE cell = ?").run(cell);
    log(`region ${cell} dropped, no positions in ${ACTIVE_DAYS} days`);
  }
  for (const cell of cells) {
    db.prepare("INSERT INTO transit_regions (cell, seen_at) VALUES (?, ?) ON CONFLICT(cell) DO UPDATE SET seen_at = excluded.seen_at").run(cell, now);
  }
  if (cells.length === 0) return result;

  let catalog;
  try {
    catalog = await loadCatalog(force);
  } catch (error) {
    warn(`catalog not available: ${error.message}`);
    return result;
  }

  // A feed that several cells share is downloaded once per run.
  const downloaded = new Set();
  for (const cell of cells) {
    const wanted = feedsForCell(cell, catalog, preferred);
    for (const row of db.prepare("SELECT id, source FROM transit_feeds WHERE cell = ?").all(cell)) {
      if (!wanted.some((f) => f.source === row.source)) db.prepare("DELETE FROM transit_feeds WHERE id = ?").run(row.id);
    }
    for (const feed of wanted) {
      db.prepare(
        `INSERT INTO transit_feeds (cell, source, name, provider, url, license) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cell, source) DO UPDATE SET name = excluded.name, provider = excluded.provider, url = excluded.url, license = excluded.license`
      ).run(cell, feed.source, feed.name, feed.provider, feed.url, feed.license);
      const row = db.prepare("SELECT id, updated_at FROM transit_feeds WHERE cell = ? AND source = ?").get(cell, feed.source);
      if (!force && row.updated_at !== null && now - Number(row.updated_at) < REFRESH_MS) continue;
      try {
        const file = await ensureFeedFile(feed, force && !downloaded.has(feed.source));
        downloaded.add(feed.source);
        const slice = await readSlice(file, cellBounds(cell, MARGIN_KM));
        storeSlice(row.id, slice);
        db.prepare("UPDATE transit_feeds SET updated_at = ?, stops = ?, routes = ?, trips = ? WHERE id = ?").run(
          now,
          slice.stops.length,
          slice.routes.length,
          slice.trips.length,
          row.id
        );
        result.imported++;
        log(`${feed.name} for ${cell}: ${slice.stops.length} stops, ${slice.routes.length} routes, ${slice.trips.length} trips`);
      } catch (error) {
        result.failed++;
        warn(`${feed.name} for ${cell} failed: ${error.message}`);
      }
    }
  }
  return result;
}

// Refreshes in the background: shortly after the start and then every few hours it looks
// whether a region is new or a feed is older than a week. The start never waits for it.
export function startTransit({ delayMs = 15_000, everyMs = 6 * 3_600_000 } = {}) {
  if (!config.transit) return { stop() {} };
  const tick = () => refreshTransit().catch((error) => warn(error.message));
  const first = setTimeout(tick, delayMs);
  first.unref?.();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}

// ---- status ----

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

// What GET /api/transit answers: every region with the feeds it has, newest import per region.
export function transitStatus() {
  if (!config.transit) return { enabled: false, regions: [] };
  const db = getDb();
  const feeds = db.prepare("SELECT cell, name, provider, license, stops, routes, trips, updated_at FROM transit_feeds ORDER BY cell, name").all();
  const regions = db
    .prepare("SELECT cell FROM transit_regions ORDER BY cell")
    .all()
    .map(({ cell }) => {
      const own = feeds.filter((f) => f.cell === cell);
      const stamps = own.map((f) => f.updated_at).filter((s) => s !== null).map(Number);
      return {
        cell,
        feeds: own.map((f) => ({
          name: f.name,
          provider: f.provider,
          license: f.license,
          stops: Number(f.stops),
          routes: Number(f.routes),
          trips: Number(f.trips),
          updatedAt: iso(f.updated_at),
        })),
        updatedAt: stamps.length ? iso(Math.max(...stamps)) : null,
      };
    });
  return { enabled: true, regions };
}

export function resetTransit() {
  running = null;
}

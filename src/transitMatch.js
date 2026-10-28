import { config } from "./config.js";
import { getDb } from "./db.js";
import { distanceM } from "./history.js";
import { LOOKUP_TIMEOUT_MS, askOverpass, overpassEnabled } from "./overpass.js";

// Which bus, tram or train a trip of the timeline was. A trip is a candidate when it starts
// and ends at a stop, is faster than walking or cycling, and halted every few hundred metres
// the way a bus does. Then the timetables (src/transit.js) say which lines serve both stops
// in that order, the shape of the line has to follow the fixes, and of several lines the one
// with a departure close to the observed one wins. Without timetables the route relations
// of OpenStreetMap give at least the line number. Results and corrections are stored per
// account, device and trip start, so nothing is computed twice.

export const NEAR_STOP_M = 60;
const MIN_SPEED_KMH = 12;
export const HALT_SPACING_M = { min: 300, max: 900 };
const MAX_SHAPE_DISTANCE_M = 25;
// Fixes come every 5 s or 15 m on the move, so two fixes close together but this far apart
// in time mean the vehicle stood still: at a stop, or at a red light.
const HALT_MIN_S = 12;
const HALT_MAX_M = 40;
const KM_PER_DEG = 111.32;

export const TRANSIT_KINDS = ["bus", "tram", "subway", "train", "ferry"];
export const TRIP_MODES = ["walking", "cycling", "driving", "transit"];

// ---- the profile of a trip ----

// Average speed and the halts along the way, from the fixes of a trip.
export function rideProfile(fixes) {
  let distance = 0;
  const halts = [];
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1];
    const b = fixes[i];
    const d = distanceM(a.lat, a.lon, b.lat, b.lon);
    const dt = (b.ts - a.ts) / 1000;
    if (dt >= HALT_MIN_S && d <= HALT_MAX_M) {
      // Several slow fixes in a row are one halt.
      if (!halts.length || distance - halts[halts.length - 1] > HALT_MAX_M) halts.push(distance);
    }
    distance += d;
  }
  const seconds = fixes.length ? (fixes[fixes.length - 1].ts - fixes[0].ts) / 1000 : 0;
  return {
    distanceM: distance,
    speedKmh: seconds > 0 ? (distance / seconds) * 3.6 : 0,
    halts: halts.length,
    haltSpacingM: distance / (halts.length + 1),
  };
}

export function looksLikeRide(profile) {
  return profile.speedKmh >= MIN_SPEED_KMH && profile.haltSpacingM >= HALT_SPACING_M.min && profile.haltSpacingM <= HALT_SPACING_M.max;
}

// Bus, tram, subway, train or ferry from a GTFS route_type, the basic and the extended ones.
export function kindOf(routeType) {
  const t = Number(routeType);
  if (t === 0 || t === 5 || t === 6 || t === 7 || (t >= 900 && t <= 906)) return "tram";
  if (t === 1 || (t >= 400 && t <= 404)) return "subway";
  if (t === 2 || t === 12 || t === 405 || (t >= 100 && t <= 117)) return "train";
  if (t === 4 || (t >= 1000 && t <= 1021) || t === 1200) return "ferry";
  return "bus";
}

// ---- geometry ----

// Metres east and north of an origin, good enough across a city.
function projector(lat0, lon0) {
  const kx = KM_PER_DEG * 1000 * Math.cos((lat0 * Math.PI) / 180);
  const ky = KM_PER_DEG * 1000;
  return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
}

function pointToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

// How far the fixes stray from a line's shape on average: the mean of each fix's distance
// to the nearest part of the shape.
export function meanShapeDistance(fixes, shape) {
  if (!fixes.length || shape.length < 2) return Infinity;
  const project = projector(fixes[0].lat, fixes[0].lon);
  const line = shape.map((p) => project(p.lat, p.lon));
  let sum = 0;
  for (const fix of fixes) {
    const p = project(fix.lat, fix.lon);
    let best = Infinity;
    for (let i = 1; i < line.length; i++) best = Math.min(best, pointToSegment(p, line[i - 1], line[i]));
    sum += best;
  }
  return sum / fixes.length;
}

// ---- GTFS ----

function stopsNear(lat, lon) {
  const dLat = NEAR_STOP_M / (KM_PER_DEG * 1000);
  const dLon = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  return getDb()
    .prepare("SELECT feed_id, id, name, lat, lon FROM transit_stops WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?")
    .all(lat - dLat, lat + dLat, lon - dLon, lon + dLon)
    .map((s) => ({ ...s, distance: distanceM(lat, lon, s.lat, s.lon) }))
    .filter((s) => s.distance <= NEAR_STOP_M)
    .sort((a, b) => a.distance - b.distance);
}

// Seconds since local midnight in the agency's time zone, or null when the zone is unknown.
export function localSeconds(ts, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ts));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return get("hour") * 3600 + get("minute") * 60 + get("second");
  } catch {
    return null;
  }
}

// Timetables count past midnight ("25:10:00"), so a departure is compared on the nearest day.
function departureGap(departure, observed) {
  if (departure === null || observed === null) return Infinity;
  return Math.min(...[-1, 0, 1].map((day) => Math.abs(departure - (observed + day * 86_400))));
}

const place = (stop) => ({ name: stop.name, lat: stop.lat, lon: stop.lon });

// The line of a trip according to the timetables, or null.
export function matchGtfs(trip) {
  const fixes = trip.fixes;
  const from = stopsNear(fixes[0].lat, fixes[0].lon);
  const to = stopsNear(fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon);
  if (!from.length || !to.length) return null;
  const db = getDb();
  const shapeCache = new Map();
  const shapeFits = (feedId, shapeId) => {
    if (!shapeId) return true;
    const key = `${feedId}:${shapeId}`;
    if (!shapeCache.has(key)) {
      const shape = db.prepare("SELECT lat, lon FROM transit_shapes WHERE feed_id = ? AND id = ? ORDER BY seq").all(feedId, shapeId);
      shapeCache.set(key, shape.length < 2 || meanShapeDistance(fixes, shape) <= MAX_SHAPE_DISTANCE_M);
    }
    return shapeCache.get(key);
  };

  let best = null;
  for (const feedId of new Set(from.map((s) => s.feed_id))) {
    const fromIds = from.filter((s) => s.feed_id === feedId).map((s) => s.id);
    const toIds = to.filter((s) => s.feed_id === feedId).map((s) => s.id);
    if (!toIds.length) continue;
    const marks = (ids) => ids.map(() => "?").join(",");
    // Every trip of the feed that calls at one of the boarding stops and later at one of the alighting stops.
    const rows = db
      .prepare(
        `SELECT t.id AS trip_id, t.route_id, t.headsign, t.shape_id, a.stop_id AS from_id, b.stop_id AS to_id, a.departure,
                r.short_name, r.long_name, r.type, r.color, r.text_color, r.agency, r.timezone
         FROM transit_stop_times a
         JOIN transit_stop_times b ON b.feed_id = a.feed_id AND b.trip_id = a.trip_id AND b.seq > a.seq
         JOIN transit_trips t ON t.feed_id = a.feed_id AND t.id = a.trip_id
         JOIN transit_routes r ON r.feed_id = t.feed_id AND r.id = t.route_id
         WHERE a.feed_id = ? AND a.stop_id IN (${marks(fromIds)}) AND b.stop_id IN (${marks(toIds)})`
      )
      .all(feedId, ...fromIds, ...toIds);
    for (const row of rows) {
      if (!shapeFits(feedId, row.shape_id)) continue;
      const gap = departureGap(row.departure, localSeconds(trip.start, row.timezone));
      if (!best || gap < best.gap) best = { row, gap, feedId };
    }
  }
  if (!best) return null;
  const { row } = best;
  const fromStop = from.find((s) => s.feed_id === best.feedId && s.id === row.from_id);
  const toStop = to.find((s) => s.feed_id === best.feedId && s.id === row.to_id);
  return {
    kind: kindOf(row.type),
    line: row.short_name || row.long_name || row.route_id,
    headsign: row.headsign ?? null,
    color: row.color ?? null,
    textColor: row.text_color ?? null,
    agency: row.agency ?? null,
    from: place(fromStop),
    to: place(toStop),
    source: "gtfs",
  };
}

// ---- OpenStreetMap ----

const OSM_CELL_DEG = 0.002;
const OSM_RADIUS_M = 150;
const OSM_CACHE_MS = 30 * 86_400_000;
const OSM_RETRY_MS = 10 * 60_000;
const OSM_KINDS = { bus: "bus", trolleybus: "bus", tram: "tram", light_rail: "tram", subway: "subway", train: "train", ferry: "ferry" };

const osmCellOf = (lat, lon) => {
  const y = Math.round(lat / OSM_CELL_DEG);
  const x = Math.round(lon / OSM_CELL_DEG);
  return { key: `${y}:${x}`, lat: y * OSM_CELL_DEG, lon: x * OSM_CELL_DEG };
};

// The named stops around a spot and the route relations that call at them.
function osmQuery(lat, lon) {
  const around = `around:${OSM_RADIUS_M},${lat.toFixed(6)},${lon.toFixed(6)}`;
  return `[out:json][timeout:${Math.round(LOOKUP_TIMEOUT_MS / 1000)}];
(node(${around})[highway=bus_stop][name];node(${around})[public_transport~"^(platform|stop_position)$"][name];node(${around})[railway~"^(tram_stop|halt|station)$"][name];)->.s;
.s out;
rel(bn.s)[type=route][route~"^(${Object.keys(OSM_KINDS).join("|")})$"];
out tags;`;
}

const hexColour = (value) => (/^#[0-9a-f]{6}$/i.test(value ?? "") ? value.toLowerCase() : null);

// What Overpass returned, boiled down: stops with a name, routes with a line number.
export function toOsmTransit(elements = []) {
  const stops = [];
  const routes = [];
  for (const el of elements) {
    if (el.type === "node" && el.tags?.name && el.lat !== undefined) stops.push({ name: el.tags.name, lat: el.lat, lon: el.lon });
    if (el.type === "relation" && OSM_KINDS[el.tags?.route] && (el.tags.ref || el.tags.name)) {
      routes.push({
        id: el.id,
        kind: OSM_KINDS[el.tags.route],
        line: el.tags.ref || el.tags.name,
        headsign: el.tags.to ?? null,
        color: hexColour(el.tags.colour),
        agency: el.tags.operator ?? null,
      });
    }
  }
  return { stops, routes };
}

const osmInFlight = new Map();
const osmFailedAt = new Map();

function cachedOsm(key, now = Date.now()) {
  const row = getDb().prepare("SELECT fetched_at, data FROM transit_osm_cache WHERE cell = ?").get(key);
  if (!row || now - Number(row.fetched_at) > OSM_CACHE_MS) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

// The OSM stops and routes around a spot, from the cache. Otherwise asked once in the
// background; the promise resolves when the answer is there (null when it failed).
function osmAround(lat, lon) {
  const cell = osmCellOf(lat, lon);
  const cached = cachedOsm(cell.key);
  if (cached) return { cached, pending: null };
  if (!overpassEnabled() || Date.now() - (osmFailedAt.get(cell.key) ?? 0) < OSM_RETRY_MS) return { cached: null, pending: null };
  if (!osmInFlight.has(cell.key)) {
    osmInFlight.set(
      cell.key,
      askOverpass(osmQuery(cell.lat, cell.lon))
        .then((elements) => {
          const data = toOsmTransit(elements);
          getDb()
            .prepare("INSERT OR REPLACE INTO transit_osm_cache (cell, fetched_at, data) VALUES (?, ?, ?)")
            .run(cell.key, Date.now(), JSON.stringify(data));
          return data;
        })
        .catch((error) => {
          osmFailedAt.set(cell.key, Date.now());
          console.warn("Transit lookup failed:", error.message);
          return null;
        })
        .finally(() => osmInFlight.delete(cell.key))
    );
  }
  return { cached: null, pending: osmInFlight.get(cell.key) };
}

const nearestStop = (stops, lat, lon) =>
  stops
    .map((s) => ({ ...s, distance: distanceM(lat, lon, s.lat, s.lon) }))
    .filter((s) => s.distance <= NEAR_STOP_M)
    .sort((a, b) => a.distance - b.distance)[0] ?? null;

// The line of a trip according to OpenStreetMap: a route that calls at a stop next to the
// start and at one next to the end. Only the cache is read here.
export function matchOsm(trip) {
  const fixes = trip.fixes;
  const start = cachedOsm(osmCellOf(fixes[0].lat, fixes[0].lon).key);
  const end = cachedOsm(osmCellOf(fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon).key);
  if (!start || !end) return null;
  const from = nearestStop(start.stops, fixes[0].lat, fixes[0].lon);
  const to = nearestStop(end.stops, fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon);
  if (!from || !to) return null;
  const endIds = new Set(end.routes.map((r) => r.id));
  const route = start.routes.find((r) => endIds.has(r.id));
  if (!route) return null;
  return {
    kind: route.kind,
    line: route.line,
    headsign: route.headsign,
    color: route.color,
    textColor: null,
    agency: route.agency,
    from: place(from),
    to: place(to),
    source: "osm",
  };
}

// ---- stored results and corrections ----

// Changes whenever timetable data is imported: stored "no line" results older than this are
// looked at again, the data might know the line now.
const dataStamp = () => Number(getDb().prepare("SELECT MAX(updated_at) AS stamp FROM transit_feeds").get().stamp ?? 0);

function storedResult(userId, deviceId, trip) {
  const row = getDb()
    .prepare("SELECT end, transit, data_stamp FROM trip_transit WHERE user_id = ? AND device_id = ? AND start = ?")
    .get(userId, deviceId, trip.start);
  if (!row || Number(row.end) !== trip.end) return undefined;
  if (row.transit === null && Number(row.data_stamp) < dataStamp()) return undefined;
  return row.transit === null ? null : JSON.parse(row.transit);
}

function storeResult(userId, deviceId, trip, transit) {
  getDb()
    .prepare("INSERT OR REPLACE INTO trip_transit (user_id, device_id, start, end, transit, data_stamp) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, deviceId, trip.start, trip.end, transit ? JSON.stringify(transit) : null, dataStamp());
}

// "That was by car": remembered per account, device and trip start; "auto" forgets it.
// False when no trip of that device starts there.
export function setTripMode(userId, deviceId, start, mode) {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM positions WHERE user_id = ? AND device_id = ? AND ts = ?").get(userId, deviceId, start)) return false;
  if (mode === "auto") db.prepare("DELETE FROM trip_modes WHERE user_id = ? AND device_id = ? AND start = ?").run(userId, deviceId, start);
  else db.prepare("INSERT OR REPLACE INTO trip_modes (user_id, device_id, start, mode) VALUES (?, ?, ?, ?)").run(userId, deviceId, start, mode);
  return true;
}

function corrections(userId, deviceId, from, to) {
  return new Map(
    getDb()
      .prepare("SELECT start, mode FROM trip_modes WHERE user_id = ? AND device_id = ? AND start >= ? AND start <= ?")
      .all(userId, deviceId, from, to)
      .map((r) => [Number(r.start), r.mode])
  );
}

// Gives the trips of a timeline their line. Stored results come first, then the timetables,
// then OpenStreetMap; lookups that are not cached yet get up to waitMs, the rest is there on
// the next load. A correction wins over everything.
export async function matchTransit(userId, deviceId, segments, { waitMs = 3_000 } = {}) {
  const allTrips = segments.filter((s) => s.type === "trip");
  const trips = allTrips.filter((s) => !s.gap && s.fixes?.length >= 2);
  const undecided = [];
  const pending = [];
  if (config.transit) {
    for (const trip of trips) {
      const stored = storedResult(userId, deviceId, trip);
      if (stored !== undefined) {
        trip.transit = stored;
        continue;
      }
      if (!looksLikeRide(rideProfile(trip.fixes))) {
        trip.transit = null;
        storeResult(userId, deviceId, trip, null);
        continue;
      }
      const gtfs = matchGtfs(trip);
      if (gtfs) {
        trip.transit = gtfs;
        storeResult(userId, deviceId, trip, gtfs);
        continue;
      }
      const ends = [trip.fixes[0], trip.fixes[trip.fixes.length - 1]].map((p) => osmAround(p.lat, p.lon));
      pending.push(...ends.map((e) => e.pending).filter(Boolean));
      undecided.push(trip);
    }
    if (pending.length) {
      let timer;
      await Promise.race([Promise.all(pending), new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
    }
    for (const trip of undecided) {
      const ends = [trip.fixes[0], trip.fixes[trip.fixes.length - 1]];
      const known = !overpassEnabled() || ends.every((p) => cachedOsm(osmCellOf(p.lat, p.lon).key));
      // Without an answer yet nothing is stored, the next load asks the cache again.
      if (!known) continue;
      trip.transit = matchOsm(trip);
      storeResult(userId, deviceId, trip, trip.transit);
    }
  }

  const corrected = allTrips.length ? corrections(userId, deviceId, allTrips[0].start, allTrips[allTrips.length - 1].start) : new Map();
  for (const trip of allTrips) {
    const correction = corrected.get(trip.start);
    if (correction) {
      trip.mode = correction;
      trip.corrected = true;
    } else if (trip.transit) trip.mode = "transit";
    if (trip.mode === "transit") trip.transit = trip.transit ?? null;
    else delete trip.transit;
  }
}

export function resetTransitMatches() {
  osmInFlight.clear();
  osmFailedAt.clear();
}

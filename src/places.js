import { config } from "./config.js";
import { getDb } from "./db.js";
import { distanceM } from "./history.js";
import { LOOKUP_TIMEOUT_MS, askOverpass, resetOverpass, userAgent } from "./overpass.js";

// Names for the visits of a timeline. A place the person named or confirmed wins.
// Otherwise the nearest fitting place from OpenStreetMap, asked through Overpass.
// Overpass answers are cached per cell of about 50 m, so every spot is asked once.
// When Overpass is busy (public servers often are), Photon answers instead.

export const PLACE_KINDS = [
  "home",
  "work",
  "cafe",
  "restaurant",
  "bar",
  "grocery",
  "shop",
  "station",
  "school",
  "health",
  "sport",
  "park",
  "culture",
  "hotel",
  "worship",
  "fuel",
  "building",
  "place",
];

const DEFAULT_RADIUS_M = 60;
export const MIN_RADIUS_M = 15;
export const MAX_RADIUS_M = 1000;
// How far a claimed place reaches past the spot it was picked for.
const CLAIM_MARGIN_M = 25;
// OSM places further from where the person stayed than this are not offered.
const MATCH_M = 80;
const CELL_DEG = 0.0005;
// Part of every cache key. Raise it when the kinds change, cached cells are then asked again.
const CACHE_VERSION = 1;
const QUERY_RADIUS_M = 120;
const CACHE_MS = 30 * 86_400_000;
const RETRY_MS = 10 * 60_000;

// ---- own places ----

const rowToPlace = (row) => ({
  id: Number(row.id),
  name: row.name,
  kind: row.kind,
  lat: row.lat,
  lon: row.lon,
  radiusM: Number(row.radius_m),
  osmId: row.osm_id ?? null,
});

export function listPlaces(userId) {
  return getDb().prepare("SELECT * FROM places WHERE user_id = ? ORDER BY name COLLATE NOCASE").all(userId).map(rowToPlace);
}

export function getPlace(userId, id) {
  const row = getDb().prepare("SELECT * FROM places WHERE user_id = ? AND id = ?").get(userId, id);
  return row ? rowToPlace(row) : null;
}

// The own place this spot belongs to: the nearest one whose radius covers it.
export function ownPlaceAt(userId, lat, lon, places = listPlaces(userId)) {
  let best = null;
  for (const place of places) {
    const d = distanceM(lat, lon, place.lat, place.lon);
    if (d <= place.radiusM && (!best || d < best.d)) best = { place, d };
  }
  return best?.place ?? null;
}

// Kinds that need no typed name: tagging a visit as home or work is enough.
export const TAG_KINDS = ["home", "work"];
const TAG_NAMES = { home: "Home", work: "Work" };

// "Home" for the first home, then "Home 2", "Home 3", compared without case against the
// person's other place names. The place being retagged does not block its own name.
export function defaultPlaceName(userId, kind, exceptId = null) {
  const base = TAG_NAMES[kind] ?? kind;
  const taken = new Set(
    listPlaces(userId)
      .filter((p) => p.id !== exceptId)
      .map((p) => p.name.toLocaleLowerCase())
  );
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(name.toLocaleLowerCase())) return name;
  }
}

// "I was here: Café Mohr". When an own place already covers the spot it is corrected,
// otherwise a new one starts there. Without a name (a tag) the covering place keeps its
// name when it already is that kind, otherwise the next free default name is used.
export function savePlaceAt(userId, { lat, lon, name, kind = "place", radiusM, osmId = null }) {
  const existing = ownPlaceAt(userId, lat, lon);
  if (name == null) name = existing?.kind === kind ? existing.name : defaultPlaceName(userId, kind, existing?.id ?? null);
  if (existing) {
    getDb()
      .prepare("UPDATE places SET name = ?, kind = ?, osm_id = ?, radius_m = ? WHERE id = ?")
      .run(name, kind, osmId, radiusM ?? existing.radiusM, existing.id);
    return getPlace(userId, existing.id);
  }
  const result = getDb()
    .prepare(
      "INSERT INTO places (user_id, name, kind, lat, lon, radius_m, osm_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(userId, name, kind, lat, lon, radiusM ?? DEFAULT_RADIUS_M, osmId, new Date().toISOString());
  return getPlace(userId, Number(result.lastInsertRowid));
}

// A place that grew or shrank: inside and outside of the arrival alerts start over, the old
// edge would turn the next fix into an arrival or a departure that never happened.
function forgetPresence(placeId) {
  getDb().prepare("DELETE FROM place_presence WHERE place_id = ?").run(placeId);
}

export function updatePlace(userId, id, { name, kind, radiusM }) {
  const place = getPlace(userId, id);
  if (!place) return null;
  getDb()
    .prepare("UPDATE places SET name = ?, kind = ?, radius_m = ? WHERE id = ?")
    .run(name ?? place.name, kind ?? place.kind, radiusM ?? place.radiusM, id);
  if ((radiusM ?? place.radiusM) !== place.radiusM) forgetPresence(id);
  return getPlace(userId, id);
}

// "This visit was at that own place": it grows to cover the spot (never shrinks), and own
// places closer to the spot that covered it shrink just enough to let go of it, so the choice
// wins from now on. One closer than MIN_RADIUS_M keeps the spot, rename that one instead.
export function claimSpot(userId, id, lat, lon) {
  const place = getPlace(userId, id);
  if (!place) return null;
  const db = getDb();
  const d = distanceM(lat, lon, place.lat, place.lon);
  const reach = Math.min(MAX_RADIUS_M, Math.ceil(d + CLAIM_MARGIN_M));
  if (reach > place.radiusM) {
    db.prepare("UPDATE places SET radius_m = ? WHERE id = ?").run(reach, id);
    forgetPresence(id);
  }
  for (const other of listPlaces(userId)) {
    if (other.id === id) continue;
    const od = distanceM(lat, lon, other.lat, other.lon);
    if (od <= other.radiusM && od < d) {
      db.prepare("UPDATE places SET radius_m = ? WHERE id = ?").run(Math.max(MIN_RADIUS_M, Math.floor(od) - 1), other.id);
      forgetPresence(other.id);
    }
  }
  return getPlace(userId, id);
}

export function deletePlace(userId, id) {
  return Number(getDb().prepare("DELETE FROM places WHERE user_id = ? AND id = ?").run(userId, id).changes) > 0;
}

// ---- OpenStreetMap ----

const KINDS_BY_TAG = {
  amenity: {
    cafe: "cafe",
    ice_cream: "cafe",
    restaurant: "restaurant",
    fast_food: "restaurant",
    food_court: "restaurant",
    bar: "bar",
    pub: "bar",
    biergarten: "bar",
    nightclub: "bar",
    school: "school",
    university: "school",
    college: "school",
    kindergarten: "school",
    library: "culture",
    cinema: "culture",
    theatre: "culture",
    arts_centre: "culture",
    hospital: "health",
    clinic: "health",
    doctors: "health",
    dentist: "health",
    pharmacy: "health",
    place_of_worship: "worship",
    fuel: "fuel",
    bus_station: "station",
    bank: "shop",
    post_office: "shop",
    townhall: "building",
  },
  shop: { supermarket: "grocery", convenience: "grocery", bakery: "grocery", butcher: "grocery", greengrocer: "grocery" },
  tourism: { hotel: "hotel", hostel: "hotel", guest_house: "hotel", museum: "culture", gallery: "culture", zoo: "park", attraction: "culture" },
  leisure: { park: "park", garden: "park", playground: "park", fitness_centre: "sport", sports_centre: "sport", stadium: "sport", swimming_pool: "sport" },
  railway: { station: "station", halt: "station" },
  public_transport: { station: "station" },
  healthcare: {},
};

export function kindForTags(tags = {}) {
  if (tags.building === "train_station") return "station";
  for (const [key, values] of Object.entries(KINDS_BY_TAG)) {
    const value = tags[key];
    if (!value) continue;
    if (values[value]) return values[value];
    if (key === "shop") return "shop";
    if (key === "healthcare") return "health";
  }
  if (tags.office || tags.craft) return "work";
  if (tags.building) return "building";
  return null;
}

// What Overpass returned, boiled down to what a visit needs.
export function toCandidates(elements = []) {
  const out = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const name = el.tags?.name;
    const kind = kindForTags(el.tags);
    if (lat === undefined || lon === undefined || !name || !kind) continue;
    out.push({
      osmId: `${el.type}/${el.id}`,
      name,
      kind,
      lat,
      lon,
      ...(el.tags.opening_hours && { openingHours: el.tags.opening_hours }),
    });
  }
  return out;
}

const cellOf = (lat, lon) => {
  const y = Math.round(lat / CELL_DEG);
  const x = Math.round(lon / CELL_DEG);
  return { key: `${CACHE_VERSION}:${y}:${x}`, lat: y * CELL_DEG, lon: x * CELL_DEG };
};

function cachedCell(key, now = Date.now()) {
  const row = getDb().prepare("SELECT fetched_at, candidates FROM place_cache WHERE cell = ?").get(key);
  if (!row || now - Number(row.fetched_at) > CACHE_MS) return null;
  try {
    return JSON.parse(row.candidates);
  } catch {
    return null;
  }
}

const inFlight = new Map();
const failedAt = new Map();

export const lookupEnabled = () => Boolean(config.placeLookupUrl || config.placeFallbackUrl);

function overpassQuery(lat, lon) {
  const around = `around:${QUERY_RADIUS_M},${lat.toFixed(6)},${lon.toFixed(6)}`;
  return `[out:json][timeout:${Math.round(LOOKUP_TIMEOUT_MS / 1000)}];
nwr(${around})[name][~"^(amenity|shop|tourism|leisure|office|craft|railway|public_transport|healthcare|building)$"~"."];
out tags center 80;`;
}

const askOverpassFor = async (cell) => toCandidates(await askOverpass(overpassQuery(cell.lat, cell.lon)));

const PHOTON_TYPES = { N: "node", W: "way", R: "relation" };

// Photon features look like Overpass elements once their key and value are tags again.
export function photonToElements(features = []) {
  return features.map(({ geometry, properties: p = {} }) => ({
    type: PHOTON_TYPES[p.osm_type] ?? "node",
    id: p.osm_id,
    lon: geometry?.coordinates?.[0],
    lat: geometry?.coordinates?.[1],
    tags: { ...(p.osm_key && { [p.osm_key]: p.osm_value }), ...(p.name && { name: p.name }) },
  }));
}

async function askPhoton(cell) {
  const url = new URL(config.placeFallbackUrl);
  url.search = new URLSearchParams({
    lat: cell.lat.toFixed(6),
    lon: cell.lon.toFixed(6),
    limit: "40",
    radius: String(QUERY_RADIUS_M / 1000),
  }).toString();
  const res = await fetch(url, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Photon answered ${res.status}`);
  return toCandidates(photonToElements((await res.json()).features));
}

async function fetchCell(cell) {
  let candidates = null;
  let failure = null;
  for (const ask of [config.placeLookupUrl && askOverpassFor, config.placeFallbackUrl && askPhoton].filter(Boolean)) {
    try {
      candidates = await ask(cell);
      break;
    } catch (error) {
      failure = error;
    }
  }
  if (!candidates) throw failure;
  getDb()
    .prepare("INSERT OR REPLACE INTO place_cache (cell, fetched_at, candidates) VALUES (?, ?, ?)")
    .run(cell.key, Date.now(), JSON.stringify(candidates));
  return candidates;
}

// The OSM places around a spot. Served from the cache, otherwise asked once (also when
// several visits ask at the same time). A failed lookup is not repeated for a while.
export function nearbyCandidates(lat, lon) {
  const cell = cellOf(lat, lon);
  const cached = cachedCell(cell.key);
  if (cached) return Promise.resolve(cached);
  if (!lookupEnabled() || Date.now() - (failedAt.get(cell.key) ?? 0) < RETRY_MS) return Promise.resolve(null);
  if (!inFlight.has(cell.key)) {
    inFlight.set(
      cell.key,
      fetchCell(cell)
        .catch((error) => {
          failedAt.set(cell.key, Date.now());
          console.warn("Place lookup failed:", error.message);
          return null;
        })
        .finally(() => inFlight.delete(cell.key))
    );
  }
  return inFlight.get(cell.key);
}

export function cachedCandidates(lat, lon) {
  return cachedCell(cellOf(lat, lon).key);
}

// ---- picking the place of a visit ----

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function dayList(spec) {
  const days = new Set();
  for (const part of spec.split(",")) {
    const [from, to] = part.trim().split("-");
    const a = DAYS.indexOf(from);
    const b = to ? DAYS.indexOf(to) : a;
    if (a < 0 || b < 0) return null;
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  return days;
}

const minutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// Whether OSM opening hours say the place is open at that local time. Only the common
// forms ("Mo-Fr 08:00-18:00; Sa 09:00-14:00", "24/7") are read, anything else is
// unknown (null) and does not count against the place.
export function openAt(openingHours, localDay, localMinute) {
  if (!openingHours) return null;
  if (openingHours.trim() === "24/7") return true;
  let known = false;
  for (const rule of openingHours.split(";")) {
    const match = /^\s*([A-Za-z,-]+)?\s*((?:\d{1,2}:\d{2}-\d{1,2}:\d{2}\s*,?\s*)+|off|closed)\s*$/.exec(rule);
    if (!match) return null;
    const days = match[1] ? dayList(match[1]) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    known = true;
    if (!days.has(localDay) || /off|closed/.test(match[2])) continue;
    for (const span of match[2].split(",")) {
      const [from, to] = span.trim().split("-");
      if (!from || !to) continue;
      const start = minutes(from);
      let end = minutes(to);
      if (end <= start) end += 24 * 60;
      if ((localMinute >= start && localMinute < end) || localMinute + 24 * 60 < end) return true;
    }
  }
  return known ? false : null;
}

const FOOD = new Set(["cafe", "restaurant", "bar"]);

// Lower is better: metres away, plus what speaks against the place.
function score(candidate, visit, local) {
  let s = distanceM(visit.lat, visit.lon, candidate.lat, candidate.lon);
  // A named building or office says less about the stay than a café inside it.
  if (candidate.kind === "building") s += 40;
  if (candidate.kind === "work") s += 10;
  // Waiting at a station, the bakery inside it is not where you were.
  if (candidate.kind === "station") s -= 50;
  // Nobody sits in a café for half a day.
  if (FOOD.has(candidate.kind) && visit.durationMs > 3 * 3_600_000) s += 40;
  if (openAt(candidate.openingHours, local.day, local.minute) === false) s += 60;
  return s;
}

function localTime(ts, tzOffsetMin) {
  const d = new Date(ts - tzOffsetMin * 60_000);
  return { day: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export function bestCandidate(candidates, visit, tzOffsetMin = 0) {
  const local = localTime((visit.start + visit.end) / 2, tzOffsetMin);
  let best = null;
  for (const candidate of candidates ?? []) {
    if (distanceM(visit.lat, visit.lon, candidate.lat, candidate.lon) > MATCH_M) continue;
    const s = score(candidate, visit, local);
    if (!best || s < best.s) best = { candidate, s };
  }
  return best?.candidate ?? null;
}

const ownToVisitPlace = (place) => ({ id: place.id, name: place.name, kind: place.kind, source: "own", osmId: place.osmId });
const osmToVisitPlace = (c) => ({ id: null, name: c.name, kind: c.kind, source: "osm", osmId: c.osmId });

// Gives every visit of a timeline its place. Lookups that are not cached yet get up to
// waitMs, the rest continue in the background and are there on the next load.
export async function namePlaces(userId, segments, { tzOffsetMin = 0, waitMs = 3_000 } = {}) {
  const own = listPlaces(userId);
  const visits = segments.filter((s) => s.type === "visit");
  const lookups = [];
  for (const visit of visits) {
    const place = ownPlaceAt(userId, visit.lat, visit.lon, own);
    visit.place = place ? ownToVisitPlace(place) : null;
    if (!place && !cachedCandidates(visit.lat, visit.lon)) lookups.push(nearbyCandidates(visit.lat, visit.lon));
  }
  if (lookups.length) {
    let timer;
    await Promise.race([Promise.all(lookups), new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }
  let pending = false;
  for (const visit of visits) {
    if (visit.place) continue;
    const candidates = cachedCandidates(visit.lat, visit.lon);
    if (!candidates && lookupEnabled()) pending = true;
    const best = bestCandidate(candidates, visit, tzOffsetMin);
    visit.place = best ? osmToVisitPlace(best) : null;
  }
  return { pending };
}

// What "pick another place" offers: own places close by first, then OSM, nearest first.
export async function placeChoices(userId, lat, lon) {
  const own = listPlaces(userId)
    .map((p) => ({ ...ownToVisitPlace(p), distanceM: Math.round(distanceM(lat, lon, p.lat, p.lon)) }))
    .filter((p) => p.distanceM <= 300);
  const osm = ((await nearbyCandidates(lat, lon)) ?? [])
    .map((c) => ({ ...osmToVisitPlace(c), distanceM: Math.round(distanceM(lat, lon, c.lat, c.lon)) }))
    .filter((c) => c.distanceM <= QUERY_RADIUS_M);
  const byDistance = (a, b) => a.distanceM - b.distanceM;
  // OSM often has a place twice (a bakery that is also a café), the nearest one stays.
  const seen = new Set();
  return [...own.sort(byDistance), ...osm.sort(byDistance)].filter((c) => {
    const key = c.name.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resetPlaceLookups() {
  inFlight.clear();
  failedAt.clear();
  resetOverpass();
}

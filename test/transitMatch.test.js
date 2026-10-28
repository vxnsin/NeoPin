import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { distanceM, recordPosition } from "../src/history.js";
import { refreshTransit, resetTransit } from "../src/transit.js";
import { kindOf, localSeconds, looksLikeRide, meanShapeDistance, rideProfile, toOsmTransit } from "../src/transitMatch.js";
import { deviceHeaders, startServer } from "./helpers.js";
import { STOPS, fakeTransitHost, gtfsZip } from "./gtfsFixture.js";

const MIN = 60_000;
// 2025-06-10 in Berlin is UTC+2: a ride at 06:08 UTC leaves at 08:08 on the timetable.
const DAY = "2025-06-10";
const DAY0 = Date.UTC(2025, 5, 10);
const { A, B, C, D } = STOPS;

// A point `metres` along the straight lines between the stops.
function along(stops, metres) {
  let left = metres;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const length = distanceM(a.lat, a.lon, b.lat, b.lon);
    if (left <= length) return { lat: a.lat + ((b.lat - a.lat) * left) / length, lon: a.lon + ((b.lon - a.lon) * left) / length };
    left -= length;
  }
  return { lat: stops[stops.length - 1].lat, lon: stops[stops.length - 1].lon };
}

// Fixes of a vehicle along the stops: one every 5 s, and at every stop in between it stands
// still for `haltS` (the next stored fix after a halt is 20 m further, as the thinning keeps it).
function ride(startTs, stops, speedMs, haltS) {
  const fixes = [];
  const marks = [];
  let total = 0;
  for (let i = 1; i < stops.length; i++) {
    total += distanceM(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
    if (i < stops.length - 1) marks.push(total);
  }
  let ts = startTs;
  let d = 0;
  while (d < total) {
    const next = Math.min(total, d + speedMs * 5);
    const halt = marks.find((m) => m > d && m <= next);
    if (halt !== undefined && haltS > 0) {
      ts += ((halt - d) / speedMs) * 1000;
      fixes.push({ ts, ...along(stops, halt) });
      ts += haltS * 1000 + (20 / speedMs) * 1000;
      d = halt + 20;
      fixes.push({ ts, ...along(stops, d) });
      continue;
    }
    ts += ((next - d) / speedMs) * 1000;
    d = next;
    fixes.push({ ts, ...along(stops, d) });
  }
  return fixes;
}

test("the profile of a ride: average speed and halts every few hundred metres", () => {
  const bus = rideProfile(ride(DAY0, [A, B, C, D], 8, 30));
  assert.equal(bus.halts, 2);
  assert.ok(bus.speedKmh > 15 && bus.speedKmh < 29, `${bus.speedKmh} km/h`);
  assert.ok(bus.haltSpacingM > 400 && bus.haltSpacingM < 600, `${bus.haltSpacingM} m between halts`);
  assert.equal(looksLikeRide(bus), true);

  const car = rideProfile(ride(DAY0, [A, B, C, D], 15, 0));
  assert.equal(car.halts, 0);
  assert.equal(looksLikeRide(car), false, "no halts at all");
  const walk = rideProfile(ride(DAY0, [A, B, C, D], 1.4, 30));
  assert.equal(looksLikeRide(walk), false, "too slow");
});

test("GTFS route types become the five kinds", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 11, 109, 401, 700, 900, 1000].map(kindOf), [
    "tram",
    "subway",
    "train",
    "bus",
    "ferry",
    "bus",
    "train",
    "subway",
    "bus",
    "tram",
    "ferry",
  ]);
});

test("the distance of fixes to a shape, and local timetable seconds", () => {
  const fixes = ride(DAY0, [A, B, C, D], 8, 0);
  const shape = [A, B, C, D];
  assert.ok(meanShapeDistance(fixes, shape) < 1);
  const east = shape.map((p) => ({ lat: p.lat, lon: p.lon + 0.0014 }));
  assert.ok(meanShapeDistance(fixes, east) > 90, "100 m to the east");
  assert.equal(meanShapeDistance(fixes, [A]), Infinity);
  assert.equal(localSeconds(Date.UTC(2025, 5, 10, 6, 8, 0), "Europe/Berlin"), 8 * 3600 + 8 * 60);
  assert.equal(localSeconds(Date.UTC(2025, 5, 10, 6, 8, 0), "nowhere/at-all"), null);
});

test("OSM stops and route relations are boiled down to names and line numbers", () => {
  const { stops, routes } = toOsmTransit([
    { type: "node", id: 1, lat: 49.7885, lon: 9.933, tags: { highway: "bus_stop", name: "Sanderring" } },
    { type: "node", id: 2, lat: 49.7886, lon: 9.933, tags: { public_transport: "stop_position" } },
    { type: "relation", id: 77, tags: { type: "route", route: "bus", ref: "14", to: "Hauptbahnhof", operator: "WVV", colour: "#00AA00" } },
    { type: "relation", id: 78, tags: { type: "route", route: "bicycle", ref: "MR" } },
    { type: "relation", id: 79, tags: { type: "route", route: "light_rail", name: "Stadtbahn", colour: "green" } },
  ]);
  assert.deepEqual(stops, [{ name: "Sanderring", lat: 49.7885, lon: 9.933 }]);
  assert.deepEqual(routes, [
    { id: 77, kind: "bus", line: "14", headsign: "Hauptbahnhof", color: "#00aa00", agency: "WVV" },
    { id: 79, kind: "tram", line: "Stadtbahn", headsign: null, color: null, agency: null },
  ]);
});

let s;
let luis;
let host;
let dir;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "neopin-transit-"));
  config.transit = true;
  config.transitDir = dir;
  resetTransit();
  s = await startServer();
  luis = await s.account("luis");
  host = await fakeTransitHost(gtfsZip());
  config.transitCatalogUrl = host.url;
});
afterEach(async () => {
  config.placeLookupUrl = null;
  await host.close();
  await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const record = (fixes) => fixes.forEach((f) => recordPosition(luis.user.id, "phone", f.lat, f.lon, f.ts));

// Imports the test feed for the Würzburg region: a few fixes there today make it a region.
async function withTimetables() {
  const now = Date.now();
  for (let i = 0; i < 8; i++) recordPosition(luis.user.id, "phone", 49.79 + i * 0.001, 9.93, now - (8 - i) * 10 * MIN);
  const result = await refreshTransit({ now, preferred: [] });
  assert.equal(result.imported, 1);
}

// Waiting at the first stop (the last fix there 20 s before the vehicle leaves, which is
// where the trip starts), the vehicle along the stops, then a stay at the last one.
function aTrip(stops, speedMs, haltS, startMinute = 6 * 60 + 8) {
  const first = stops[0];
  const last = stops[stops.length - 1];
  record([
    { ts: DAY0 + (startMinute - 8) * MIN, ...first },
    { ts: DAY0 + startMinute * MIN - 20_000, ...first },
  ]);
  const fixes = ride(DAY0 + startMinute * MIN, stops, speedMs, haltS);
  record(fixes);
  const arrived = fixes[fixes.length - 1].ts;
  record([
    { ts: arrived + 1 * MIN, ...last },
    { ts: arrived + 6 * MIN, ...last },
    { ts: arrived + 11 * MIN, ...last },
  ]);
}

const api = (route, init = {}) =>
  fetch(`${s.baseUrl}/api${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...deviceHeaders("phone", luis.token), ...init.headers },
  });

async function theTrip() {
  const res = await api(`/timeline?deviceId=phone&date=${DAY}&tz=0`);
  assert.equal(res.status, 200);
  const { segments } = await res.json();
  assert.deepEqual(
    segments.map((seg) => seg.type),
    ["visit", "trip", "visit"]
  );
  return segments[1];
}

const BUS_10 = {
  kind: "bus",
  line: "10",
  headsign: "Hauptbahnhof",
  color: "#e30613",
  textColor: "#ffffff",
  agency: "WVV",
  from: { name: "Sanderring", lat: A.lat, lon: A.lon },
  to: { name: "Hauptbahnhof", lat: D.lat, lon: D.lon },
  source: "gtfs",
};

test("a ride along the line with halts at the stops is Bus 10", async () => {
  await withTimetables();
  aTrip([A, B, C, D], 8, 30);
  const trip = await theTrip();
  assert.equal(trip.mode, "transit");
  assert.deepEqual(trip.transit, BUS_10);
  assert.equal(trip.corrected, undefined);
  assert.equal(Number(getDb().prepare("SELECT COUNT(*) AS n FROM trip_transit WHERE transit IS NOT NULL").get().n), 1, "the match is stored");
  // Loading the day again comes from the stored result.
  assert.deepEqual((await theTrip()).transit, BUS_10);
});

test("a drive past the same stops without halts stays a drive", async () => {
  await withTimetables();
  aTrip([A, B, C, D], 15, 0);
  const trip = await theTrip();
  assert.equal(trip.mode, "driving");
  assert.equal(trip.transit, undefined);
});

test("a correction wins over the recognition until it is taken back", async () => {
  await withTimetables();
  aTrip([A, B, C, D], 8, 30);
  const trip = await theTrip();
  assert.equal(trip.mode, "transit");

  const put = (body) => api("/trips/mode", { method: "PUT", body: JSON.stringify(body) });
  assert.equal((await put({ deviceId: "phone", start: trip.start, mode: "driving" })).status, 204);
  const corrected = await theTrip();
  assert.equal(corrected.mode, "driving");
  assert.equal(corrected.corrected, true);
  assert.equal(corrected.transit, undefined);

  assert.equal((await put({ deviceId: "phone", start: trip.start, mode: "auto" })).status, 204);
  const back = await theTrip();
  assert.equal(back.mode, "transit");
  assert.equal(back.corrected, undefined);
  assert.deepEqual(back.transit, BUS_10);

  assert.equal((await put({ deviceId: "phone", start: trip.start + 1, mode: "driving" })).status, 404);
  assert.equal((await put({ deviceId: "phone", start: trip.start, mode: "flying" })).status, 400);
  const anonymous = await fetch(`${s.baseUrl}/api/trips/mode`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "phone", start: trip.start, mode: "driving" }),
  });
  assert.equal(anonymous.status, 401);
});

test("saying it was transit without a known line gives transit with no line", async () => {
  aTrip([A, B, C, D], 15, 0);
  const trip = await theTrip();
  assert.equal((await api("/trips/mode", { method: "PUT", body: JSON.stringify({ deviceId: "phone", start: trip.start, mode: "transit" }) })).status, 204);
  const said = await theTrip();
  assert.equal(said.mode, "transit");
  assert.equal(said.transit, null);
  assert.equal(said.corrected, true);
});

test("without timetables OpenStreetMap gives the line number of a ride", async () => {
  const overpass = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        elements: [
          { type: "node", id: 1, lat: A.lat, lon: A.lon, tags: { highway: "bus_stop", name: "Sanderring" } },
          { type: "node", id: 2, lat: D.lat, lon: D.lon, tags: { highway: "bus_stop", name: "Hauptbahnhof" } },
          { type: "relation", id: 77, tags: { type: "route", route: "bus", ref: "14", to: "Hauptbahnhof", operator: "WVV" } },
        ],
      })
    );
  });
  await new Promise((resolve) => overpass.listen(0, "127.0.0.1", resolve));
  config.placeLookupUrl = `http://127.0.0.1:${overpass.address().port}/api/interpreter`;
  try {
    aTrip([A, B, C, D], 8, 30);
    const trip = await theTrip();
    assert.equal(trip.mode, "transit");
    assert.deepEqual(trip.transit, {
      kind: "bus",
      line: "14",
      headsign: "Hauptbahnhof",
      color: null,
      textColor: null,
      agency: "WVV",
      from: { name: "Sanderring", lat: A.lat, lon: A.lon },
      to: { name: "Hauptbahnhof", lat: D.lat, lon: D.lon },
      source: "osm",
    });
    assert.equal(Number(getDb().prepare("SELECT COUNT(*) AS n FROM transit_osm_cache").get().n), 2, "both ends are cached");
  } finally {
    overpass.close();
  }
});

test("with TRANSIT off trips keep their speed-based mode and corrections still apply", async () => {
  config.transit = false;
  aTrip([A, B, C, D], 8, 30);
  const trip = await theTrip();
  assert.equal(trip.mode, "driving");
  assert.equal((await api("/trips/mode", { method: "PUT", body: JSON.stringify({ deviceId: "phone", start: trip.start, mode: "cycling" }) })).status, 204);
  assert.equal((await theTrip()).mode, "cycling");
});

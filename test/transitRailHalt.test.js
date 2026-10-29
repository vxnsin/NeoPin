import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { distanceM, recordPosition } from "../src/history.js";
import { refreshTransit, resetTransit } from "../src/transit.js";
import { deviceHeaders, startServer } from "./helpers.js";
import { fakeTransitHost, gtfsZip } from "./gtfsFixture.js";

// A regional train from station A over B, where it halts for a minute, to C: about 8 km in
// 8 minutes, B 1.5 km after A. Like the nationwide German feed, without line shapes.
const MIN = 60_000;
const DAY = "2025-06-10";
const DAY0 = Date.UTC(2025, 5, 10);
const A = { id: "a", name: "Altenessen", lat: 49.8, lon: 9.93 };
const C = { id: "c", name: "Hauptbahnhof", lat: 49.8519, lon: 9.995 };
const LENGTH = distanceM(A.lat, A.lon, C.lat, C.lon);
const B_AT = 1500 / LENGTH;
const B = { id: "b", name: "Zollverein", lat: A.lat + (C.lat - A.lat) * B_AT, lon: A.lon + (C.lon - A.lon) * B_AT };

// A point `f` of the way (0 to 1) from A to C, `side` metres off the line.
function between(f, side = 0) {
  const lat = A.lat + (C.lat - A.lat) * f;
  const lon = A.lon + (C.lon - A.lon) * f;
  return { lat: lat + (side / 111_320) * 0.78, lon: lon - (side / (111_320 * Math.cos((lat * Math.PI) / 180))) * 0.62 };
}

// S 2: 08:20 from A, 08:21:30 to 08:22:30 at B, 08:28 at C (Berlin, UTC+2 in June). RE 42 an
// hour later takes the same time but does not call at B: it only waits there at a signal.
function railText() {
  return {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\ndb,DB Regio,https://www.bahn.de,Europe/Berlin",
    "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\n${[A, B, C].map((s) => `${s.id},${s.name},${s.lat},${s.lon}`).join("\n")}`,
    "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\ns2,db,S 2,Essen - Dortmund,2\nre42,db,RE 42,Essen - Münster,2",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,shape_id\ns2,daily,s2-1,Dortmund Hbf,\nre42,daily,re42-1,Münster (Westf) Hbf,",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "s2-1,08:20:00,08:20:00,a,1",
      "s2-1,08:21:30,08:22:30,b,2",
      "s2-1,08:28:00,08:28:00,c,3",
      "re42-1,09:20:00,09:20:00,a,1",
      "re42-1,09:28:00,09:28:00,c,2",
    ].join("\n"),
  };
}

let s;
let luis;
let host;
let dir;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "neopin-railhalt-"));
  config.transit = true;
  config.transitDir = dir;
  resetTransit();
  s = await startServer();
  luis = await s.account("luis");
  host = await fakeTransitHost(gtfsZip({ text: railText() }));
  config.transitCatalogUrl = host.url;
  const now = Date.now();
  for (let i = 0; i < 8; i++) recordPosition(luis.user.id, "phone", 49.79 + i * 0.001, 9.93, now - (8 - i) * 10 * MIN);
  assert.equal((await refreshTransit({ now, preferred: [] })).imported, 1);
});
afterEach(async () => {
  await host.close();
  await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const S2 = DAY0 + (6 * 60 + 20) * MIN;
const RE42 = S2 + 60 * MIN;

// Where along the way (0 to 1) the train is at `ts`: on the platform before it departs, at the
// far end after it arrived. It stands `haltS` at B.
function wayAt(ts, depart, haltS) {
  const t = (ts - depart) / 1000;
  const toB = 90;
  const fromB = 330;
  if (t <= 0) return 0;
  if (t <= toB) return (B_AT * t) / toB;
  if (t <= toB + haltS) return B_AT;
  if (t <= toB + haltS + fromB) return B_AT + ((1 - B_AT) * (t - toB - haltS)) / fromB;
  return 1;
}

// A fix every `everyS` seconds, the first `phaseS` late, from 13 minutes before the departure to
// 9 minutes after the arrival; the platforms 80 m from the stations' points. `bow` bends the way
// off the line, the way a road runs.
// `walked`: instead of waiting on the platform, a stay 500 m off the line until 9 minutes before
// the departure, then the walk there, arriving 3 minutes before.
function aRide({ depart = S2, everyS = 15, phaseS = 0, haltS = 60, bow = 0, walked = false } = {}) {
  const start = depart - (walked ? 25 : 13) * MIN + phaseS * 1000;
  const end = depart + 17 * MIN;
  for (let ts = start; ts <= end; ts += everyS * 1000) {
    const f = Math.max(80 / LENGTH, Math.min(1 - 80 / LENGTH, wayAt(ts, depart, haltS)));
    const off = walked ? 500 * Math.min(1, Math.max(0, (depart - 3 * MIN - ts) / (6 * MIN))) : 0;
    const p = between(f, off || bow * Math.sin(Math.PI * f));
    recordPosition(luis.user.id, "phone", p.lat, p.lon, ts);
  }
}

async function timeline() {
  const res = await fetch(`${s.baseUrl}/api/timeline?deviceId=phone&date=${DAY}&tz=0`, { headers: deviceHeaders("phone", luis.token) });
  return (await res.json()).segments;
}

const shown = (segments) =>
  JSON.stringify(segments.map((seg) => [seg.type, seg.mode, seg.distanceM, new Date(seg.start).toISOString(), new Date(seg.end).toISOString()]));

// The visit at A, one trip, the visit at C.
async function theTrip() {
  const segments = await timeline();
  assert.deepEqual(
    segments.map((seg) => seg.type),
    ["visit", "trip", "visit"],
    shown(segments)
  );
  return segments[1];
}

// With a fix every minute or two, the few fixes after the train started reach B already.
const SPACINGS = [
  [15, 0],
  [15, 7],
  [30, 0],
  [60, 0],
  [100, 40],
  [120, 0],
  [120, 60],
];

for (const [everyS, phaseS] of SPACINGS) {
  test(`a train from A over its halt at B to C is one S 2 ride, a fix every ${everyS} s (+${phaseS} s)`, async () => {
    aRide({ everyS, phaseS });
    const trip = await theTrip();
    assert.equal(trip.mode, "transit");
    assert.equal(trip.transit.line, "S 2");
    assert.equal(trip.transit.from.name, "Altenessen");
    assert.equal(trip.transit.to.name, "Hauptbahnhof");
  });

  test(`a train that waits at B without calling there is one RE 42 ride, a fix every ${everyS} s (+${phaseS} s)`, async () => {
    aRide({ depart: RE42, everyS, phaseS });
    const trip = await theTrip();
    assert.equal(trip.mode, "transit");
    assert.equal(trip.transit.line, "RE 42");
    assert.equal(trip.transit.from.name, "Altenessen");
    assert.equal(trip.transit.to.name, "Hauptbahnhof");
  });
}

for (const everyS of [15, 30, 60]) {
  test(`a walk to A and the train over B to C: the walk, then the S 2 from A, a fix every ${everyS} s`, async () => {
    aRide({ everyS, walked: true });
    const segments = await timeline();
    assert.deepEqual(
      segments.map((seg) => [seg.type, seg.mode ?? null]),
      [
        ["visit", null],
        ["trip", "walking"],
        ["trip", "transit"],
        ["visit", null],
      ],
      shown(segments)
    );
    assert.equal(segments[2].transit.line, "S 2");
    assert.equal(segments[2].transit.from.name, "Altenessen");
  });
}

for (const everyS of [15, 120]) {
  test(`a drive from A past B to C at the train's time, on roads away from the line, stays a drive, a fix every ${everyS} s`, async () => {
    aRide({ everyS, bow: 1200 });
    const segments = await timeline();
    const trips = segments.filter((seg) => seg.type === "trip");
    assert.ok(trips.length >= 1, shown(segments));
    for (const trip of trips) {
      assert.notEqual(trip.mode, "transit", shown(segments));
      assert.equal(trip.transit, undefined);
    }
  });
}

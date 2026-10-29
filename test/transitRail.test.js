import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { distanceM, recordPosition } from "../src/history.js";
import { buildTimeline } from "../src/timeline.js";
import { refreshTransit, resetTransit } from "../src/transit.js";
import { deviceHeaders, startServer } from "./helpers.js";
import { fakeTransitHost, gtfsZip } from "./gtfsFixture.js";

// A regional train from Würzburg Hbf to Veitshöchheim, about 5 km without a stop between.
// Trains call every few kilometres, so these rides have no halts the way a bus has them.
const MIN = 60_000;
const DAY = "2025-06-10";
const DAY0 = Date.UTC(2025, 5, 10);
const HBF = { id: "hbf", name: "Würzburg Hbf", lat: 49.80155, lon: 9.93565 };
const VEI = { id: "vei", name: "Veitshöchheim", lat: 49.8306, lon: 9.8813 };

// A point `f` of the way (0 to 1) from one station to the other, `side` metres off the line.
function between(f, side = 0) {
  const lat = HBF.lat + (VEI.lat - HBF.lat) * f;
  const lon = HBF.lon + (VEI.lon - HBF.lon) * f;
  // Perpendicular to the line, roughly north-east.
  return { lat: lat + (side / 111_320) * 0.85, lon: lon + (side / (111_320 * Math.cos((lat * Math.PI) / 180))) * 0.53 };
}

function railText() {
  const shape = [];
  for (let i = 0; i <= 50; i++) {
    const p = between(i / 50);
    shape.push(`s53,${p.lat.toFixed(6)},${p.lon.toFixed(6)},${i}`);
  }
  return {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\ndb,DB Regio,https://www.bahn.de,Europe/Berlin",
    "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\n${[HBF, VEI].map((s) => `${s.id},${s.name},${s.lat},${s.lon}`).join("\n")}`,
    "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nrb53,db,RB 53,Würzburg - Gemünden,2",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,shape_id\nrb53,daily,rb53-1,Gemünden (Main),s53",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nrb53-1,08:20:00,08:20:00,hbf,1\nrb53-1,08:27:00,08:27:00,vei,2",
    "shapes.txt": `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n${shape.join("\n")}`,
  };
}

let s;
let luis;
let host;
let dir;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "neopin-rail-"));
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

const record = (fixes) => fixes.forEach((f) => recordPosition(luis.user.id, "phone", f.lat, f.lon, f.ts));

// Waiting on the platform 150 m from the station's point, the ride to a platform 150 m before
// the other station's point, then a stay there. `bow` bends the way off the line in the middle.
// `halts` stops the way that many times for 40 s at even spacing, the way a car halts at lights.
function aRide({ startMinute = 6 * 60 + 20, minutes = 7, bow = 0, halts = 0 } = {}) {
  const length = distanceM(HBF.lat, HBF.lon, VEI.lat, VEI.lon);
  const from = 150 / length;
  const to = 1 - 150 / length;
  const start = DAY0 + startMinute * MIN;
  const board = between(from);
  record([
    { ts: start - 8 * MIN, ...board },
    { ts: start - 20_000, ...board },
  ]);
  const steps = Math.round((minutes * 60) / 5);
  const haltAt = Array.from({ length: halts }, (_, k) => Math.round((steps * (k + 1)) / (halts + 1)));
  const fixes = [];
  let waited = 0;
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    const point = between(from + (to - from) * f, bow * Math.sin(Math.PI * f));
    fixes.push({ ts: start + i * 5000 + waited, ...point });
    if (haltAt.includes(i)) {
      waited += 40_000;
      fixes.push({ ts: start + i * 5000 + waited, ...point });
    }
  }
  record(fixes);
  const end = fixes[fixes.length - 1];
  record([1, 6, 11].map((m) => ({ ts: end.ts + m * MIN, lat: end.lat, lon: end.lon })));
}

async function theTrip() {
  const res = await fetch(`${s.baseUrl}/api/timeline?deviceId=phone&date=${DAY}&tz=0`, { headers: deviceHeaders("phone", luis.token) });
  const { segments } = await res.json();
  assert.deepEqual(
    segments.map((seg) => seg.type),
    ["visit", "trip", "visit"]
  );
  return segments[1];
}

test("a train ride without halts between two stations is RB 53, boarded on a long platform", async () => {
  aRide();
  const trip = await theTrip();
  assert.equal(trip.mode, "transit");
  assert.deepEqual(trip.transit, {
    kind: "train",
    line: "RB 53",
    headsign: "Gemünden (Main)",
    color: null,
    textColor: null,
    agency: "DB Regio",
    from: { name: "Würzburg Hbf", lat: HBF.lat, lon: HBF.lon },
    to: { name: "Veitshöchheim", lat: VEI.lat, lon: VEI.lon },
    source: "gtfs",
  });
});

test("a drive between the two stations at the train's time, on roads away from the line, stays a drive", async () => {
  aRide({ bow: 400 });
  const trip = await theTrip();
  assert.equal(trip.mode, "driving");
  assert.equal(trip.transit, undefined);
});

test("a train twenty minutes late is still RB 53", async () => {
  aRide({ startMinute: 6 * 60 + 40 });
  const trip = await theTrip();
  assert.equal(trip.mode, "transit");
  assert.equal(trip.transit.line, "RB 53");
});

test("three quarters of an hour late it is no train", async () => {
  aRide({ startMinute: 6 * 60 + 65 });
  assert.notEqual((await theTrip()).mode, "transit");
});

test("ten minutes before the train it is no train", async () => {
  aRide({ startMinute: 6 * 60 + 10 });
  assert.notEqual((await theTrip()).mode, "transit");
});

test("a drive along the line at the train's time that halts at three lights is no train", async () => {
  aRide({ halts: 3 });
  const trip = await theTrip();
  assert.notEqual(trip.mode, "transit");
  assert.equal(trip.transit, undefined);
});

test("the same way two hours off the timetable is no train", async () => {
  aRide({ startMinute: 8 * 60 + 20 });
  const trip = await theTrip();
  assert.equal(trip.mode, "driving");
  assert.equal(trip.transit, undefined);
});

test("a ride that takes far longer than the timetable says is no train", async () => {
  // Departs with the train but arrives 13 minutes after it: 20 instead of 7 minutes.
  aRide({ minutes: 20 });
  const trip = await theTrip();
  assert.notEqual(trip.mode, "transit");
});

test("fixes of a high-speed train are no GPS jumps", () => {
  // 300 km/h: about 417 m every five seconds.
  const points = [];
  for (let i = 0; i <= 24; i++) points.push({ ts: DAY0 + i * 5000, lat: 49 + (i * 417) / 111_320, lon: 10 });
  const { summary } = buildTimeline(points);
  assert.equal(summary.pointCount, 25);
});

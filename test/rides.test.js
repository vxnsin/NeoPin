import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { distanceM, recordPosition } from "../src/history.js";
import { setPushToken } from "../src/push.js";
import { refreshTransit, resetTransit } from "../src/transit.js";
import { createRideWatch } from "../src/rides.js";
import { localSeconds, matchLive } from "../src/transitMatch.js";
import { sentCount, startFakeFcm } from "./fakeFcm.js";
import { STOPS, fakeTransitHost, gtfsText, gtfsZip } from "./gtfsFixture.js";
import { deviceHeaders, startServer } from "./helpers.js";

const MIN = 60_000;
const { A, B, C, D } = STOPS;

// The server takes the phone's time only from the last days, so the ride happens about now: it
// boards 25 minutes ago (on one UTC day with the stay after it), and bus 10 leaves then.
function rideStart(now = Date.now()) {
  let start = Math.floor((now - 25 * MIN) / MIN) * MIN;
  const day = (ts) => new Date(ts).toISOString().slice(0, 10);
  // Shortly after midnight UTC the whole ride goes into the day before.
  if (day(start - 10 * MIN) !== day(start + 30 * MIN)) start = Math.floor(now / 86_400_000) * 86_400_000 - 45 * MIN;
  return start;
}

// The fixture's bus 10 once, leaving Sanderring at the local time of `start`, two minutes per stop.
function feedAt(start) {
  const text = gtfsText();
  const first = Math.round(localSeconds(start, "Europe/Berlin") / 60);
  const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
  text["trips.txt"] = ["route_id,service_id,trip_id,trip_headsign,shape_id", "r10,daily,bus10-now,Hauptbahnhof,s10"].join("\n");
  text["stop_times.txt"] = [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    ...[A, B, C, D].map((stop, i) => `bus10-now,${clock(first + i * 2)},${clock(first + i * 2)},${stop.id},${i + 1}`),
  ].join("\n");
  return text;
}

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

// A vehicle along the stops, a fix every 5 s, halting `haltS` at every stop in between.
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

let s;
let luis;
let host;
let dir;
let fake;
let start;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "neopin-rides-"));
  config.transit = true;
  config.transitDir = dir;
  resetTransit();
  s = await startServer();
  fake = await startFakeFcm();
  luis = await s.account("luis");
  setPushToken(luis.user.id, "phone", "luis-fcm", "android");
  start = rideStart();
  host = await fakeTransitHost(gtfsZip({ text: feedAt(start) }));
  config.transitCatalogUrl = host.url;
  // A few fixes of another device make Würzburg a region with timetables.
  const now = Date.now();
  for (let i = 0; i < 8; i++) recordPosition(luis.user.id, "tablet", 49.79 + i * 0.001, 9.93, now - 2 * 86_400_000 - i * 10 * MIN);
  assert.equal((await refreshTransit({ now, preferred: [] })).imported, 1);
});
afterEach(async () => {
  config.transit = true;
  await fake.stop();
  await host.close();
  await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const api = (route, init = {}, token = luis.token) =>
  fetch(`${s.baseUrl}/api${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...deviceHeaders("phone", token), ...init.headers },
  });

const answer = (rideId, value, token) => api("/rides/answer", { method: "POST", body: JSON.stringify({ rideId, answer: value }) }, token);

// Waiting at Sanderring, the bus along `stops`, then a stay where it ended. Everything goes over
// the phone's socket as the app sends it; the messages the phone got meanwhile come back.
async function rideOver(stops) {
  // A new login of the phone replaces its token, the routes below use the new one.
  luis.token = await s.tokenFor("luis", "phone");
  const phone = await s.device("luis", "phone", luis.token);
  const fixes = [
    { ts: start - 8 * MIN, ...A },
    { ts: start - 20_000, ...A },
    ...ride(start, stops, 8, 30),
  ];
  const last = fixes[fixes.length - 1];
  fixes.push(...[1, 6, 11].map((m) => ({ ts: last.ts + m * MIN, lat: last.lat, lon: last.lon })));
  for (const f of fixes) phone.send({ type: "updatePosition", latitude: f.lat, longitude: f.lon, recordedAt: Math.round(f.ts) });
  phone.send({ type: "ping" });
  const seen = [];
  for (let msg = await phone.next(); msg.type !== "pong"; msg = await phone.next()) seen.push(msg);
  const questions = seen.filter((m) => m.type === "rideQuestion");
  // The push goes out in the background, it is through before the fake FCM stops.
  await sentCount(fake, questions.length);
  return questions;
}

async function theTrip() {
  const res = await api(`/timeline?deviceId=phone&date=${new Date(start).toISOString().slice(0, 10)}&tz=0`);
  assert.equal(res.status, 200);
  const { segments } = await res.json();
  assert.deepEqual(segments.map((seg) => seg.type), ["visit", "trip", "visit"]);
  return segments[1];
}

const ASKED = { kind: "bus", line: "10", headsign: "Hauptbahnhof", color: "#e30613", textColor: "#ffffff", from: { name: "Sanderring", lat: A.lat, lon: A.lon } };

test("a bus ride in progress is asked about once, over the socket and as a data push", async () => {
  const questions = await rideOver([A, B, C, D]);
  assert.equal(questions.length, 1, "once per ride");
  const [question] = questions;
  assert.equal(typeof question.rideId, "string");
  assert.deepEqual(question.transit, ASKED);
  assert.equal(question.at, Math.round(start - 20_000), "boarded when the wait at the stop ended");
  assert.equal(Number(getDb().prepare("SELECT COUNT(*) AS n FROM ride_answers").get().n), 1);

  assert.equal(await sentCount(fake, 1), 1);
  const [push] = fake.sent;
  assert.equal(push.token, "luis-fcm");
  assert.equal(push.notification, undefined, "data only: the app builds the notification with Yes and No");
  assert.equal(push.android.priority, "HIGH");
  assert.deepEqual(
    { ...push.data, transit: JSON.parse(push.data.transit) },
    { type: "rideQuestion", t: "rideQuestion", rideId: question.rideId, transit: ASKED, at: String(question.at) }
  );
});

test("answering no keeps the finished trip off transit", async () => {
  const [question] = await rideOver([A, B, C, D]);
  assert.equal((await theTrip()).mode, "transit", "the timetables alone would say bus 10");

  assert.equal((await answer(question.rideId, "maybe")).status, 400);
  assert.equal((await answer("no-such-ride", "no")).status, 404);
  const anna = await s.account("anna");
  assert.equal((await answer(question.rideId, "no", anna.token)).status, 404, "someone else's ride");
  assert.equal((await answer(question.rideId, "no")).status, 204);

  const trip = await theTrip();
  assert.notEqual(trip.mode, "transit");
  assert.equal(trip.transit, undefined);
});

test("answering yes gives the trip the line, even where the finished trip alone would not match", async () => {
  // The phone stays on 120 m past Juliuspromenade and stops there, nowhere near a stop: too short
  // a stretch to cut off as a walk, so the trip ends where no timetable explains it.
  const past = along([C, D], 120);
  const [question] = await rideOver([A, B, C, past]);
  assert.deepEqual(question.transit, ASKED);
  assert.notEqual((await theTrip()).mode, "transit");

  assert.equal((await answer(question.rideId, "yes")).status, 204);
  const trip = await theTrip();
  assert.equal(trip.mode, "transit");
  assert.equal(trip.corrected, undefined);
  assert.deepEqual(trip.transit, {
    ...ASKED,
    textColor: "#ffffff",
    agency: "WVV",
    to: { name: "Juliuspromenade", lat: C.lat, lon: C.lon },
    source: "gtfs",
  });

  // A correction by hand still wins.
  assert.equal((await api("/trips/mode", { method: "PUT", body: JSON.stringify({ deviceId: "phone", start: trip.start, mode: "driving" }) })).status, 204);
  const corrected = await theTrip();
  assert.equal(corrected.mode, "driving");
  assert.equal(corrected.transit, undefined);
});

test("without transit data nothing is asked", async () => {
  config.transit = false;
  assert.deepEqual(await rideOver([A, B, C, D]), []);
  assert.equal(fake.sent.length, 0);
});

test("the question goes to the device on the ride only", async () => {
  const tablet = await s.device("luis", "tablet");
  setPushToken(luis.user.id, "tablet", "tablet-fcm", "android");
  const [question] = await rideOver([A, B, C, D]);
  assert.deepEqual(question.transit, ASKED);
  tablet.send({ type: "ping" });
  const seen = [];
  for (let msg = await tablet.next(); msg.type !== "pong"; msg = await tablet.next()) seen.push(msg.type);
  assert.ok(!seen.includes("rideQuestion"), "the tablet was not on the bus");
  assert.deepEqual(fake.sent.map((p) => p.token), ["luis-fcm"]);
});

test("a ride that comes in as a batch is asked about too", async () => {
  luis.token = await s.tokenFor("luis", "phone");
  const phone = await s.device("luis", "phone", luis.token);
  const fixes = [{ ts: start - 8 * MIN, ...A }, { ts: start - 20_000, ...A }, ...ride(start, [A, B, C, D], 8, 30)];
  // Out of order, as a phone may keep them; the server sorts them.
  const points = fixes.map((f) => ({ latitude: f.lat, longitude: f.lon, recordedAt: Math.round(f.ts) })).reverse();
  phone.send({ type: "positionBatch", points });
  phone.send({ type: "ping" });
  const seen = [];
  for (let msg = await phone.next(); msg.type !== "pong"; msg = await phone.next()) seen.push(msg);
  const questions = seen.filter((m) => m.type === "rideQuestion");
  assert.equal(questions.length, 1);
  assert.equal(questions[0].at, Math.round(start - 20_000));
});

test("a drive that starts at a bus stop asks the timetables once, not every 30 seconds", () => {
  let lookups = 0;
  const watch = createRideWatch({ match: (fixes, found) => (lookups++, matchLive(fixes, found)) });
  const fixes = [{ ts: start - 8 * MIN, ...A }, { ts: start - 20_000, ...A }];
  // Twenty minutes east at 50 km/h, a fix every 5 seconds, past no stop of the fixture.
  for (let ts = start; ts <= start + 20 * MIN; ts += 5_000) {
    fixes.push({ ts, lat: A.lat, lon: A.lon + ((ts - start) / 1000) * 14 / 72_000 });
  }
  for (const fix of fixes) assert.equal(watch.observe(luis.user.id, "car", fix), null);
  assert.ok(lookups >= 1 && lookups <= 2, `${lookups} lookups`);
});

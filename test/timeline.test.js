import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/db.js";
import { distanceM, daysWithData, positionsBetween, pruneHistory, recordPosition } from "../src/history.js";
import { buildTimeline, dayRange } from "../src/timeline.js";
import { deviceHeaders, startServer } from "./helpers.js";

const MIN = 60_000;
const DAY0 = Date.UTC(2025, 5, 10, 0, 0, 0);

// About 111 m per 0.001 degrees of latitude.
const at = (minute, lat, lon = 11) => ({ ts: DAY0 + minute * MIN, lat, lon });

// Home, a walk-free drive to work, a stay there, and back.
function aDay() {
  const points = [];
  for (let m = 0; m <= 30; m += 5) points.push(at(m, 48.1, 11.5 + (m % 2) * 0.0001));
  for (let i = 1; i <= 6; i++) points.push(at(30 + i * 2, 48.1 + i * 0.01, 11.5 + i * 0.01));
  for (let m = 45; m <= 120; m += 5) points.push(at(m, 48.16, 11.56));
  for (let i = 1; i <= 6; i++) points.push(at(120 + i * 2, 48.16 - i * 0.01, 11.56 - i * 0.01));
  for (let m = 135; m <= 180; m += 5) points.push(at(m, 48.1, 11.5));
  return points;
}

test("distanceM measures metres between two coordinates", () => {
  assert.ok(Math.abs(distanceM(48, 11, 48.001, 11) - 111.2) < 1);
  assert.equal(distanceM(48, 11, 48, 11), 0);
});

test("a day becomes visits and the trips between them", () => {
  const { segments, summary } = buildTimeline(aDay());
  assert.deepEqual(
    segments.map((s) => s.type),
    ["visit", "trip", "visit", "trip", "visit"]
  );
  assert.equal(summary.visits, 3);

  const [home, there, work] = segments.filter((s) => s.type === "visit");
  assert.ok(home.durationMs >= 30 * MIN);
  assert.ok(Math.abs(work.lat - 48.1) < 0.001);
  assert.ok(Math.abs(there.lat - 48.16) < 0.001);

  const trip = segments[1];
  assert.equal(trip.mode, "driving");
  assert.ok(trip.distanceM > 5000);
  assert.deepEqual(trip.path[0], [home.lat, home.lon], "starts right at the home stop marker");
  assert.deepEqual(trip.path.at(-1), [there.lat, there.lon], "ends right at the next stop marker");
  assert.ok(trip.path.length >= 6);
});

// A stay, then `metres` north at `speedMs` with a fix every `everyS` seconds that jumps `jitterM`
// to the east and west in turn, then a stay. `reported` adds the phone's own speed to each fix.
function aWay(speedMs, { metres = 2000, everyS = 10, jitterM = 12, reported = false } = {}) {
  const points = [];
  for (let m = 0; m <= 20; m += 5) points.push(at(m, 48.1));
  const start = DAY0 + 20 * MIN;
  const steps = Math.round(metres / (speedMs * everyS));
  const east = (side) => (side * jitterM) / (111_320 * Math.cos((48.1 * Math.PI) / 180));
  for (let i = 1; i <= steps; i++) {
    const fix = { ts: start + i * everyS * 1000, lat: 48.1 + (i * speedMs * everyS) / 111_320, lon: 11 + east(i % 2 ? 1 : -1) };
    if (reported) fix.speed = speedMs;
    points.push(fix);
  }
  const end = points[points.length - 1];
  for (let m = 1; m <= 21; m += 5) points.push({ ts: end.ts + m * MIN, lat: end.lat, lon: 11 });
  return buildTimeline(points).segments.find((x) => x.type === "trip");
}

test("a brisk walk stays a walk even when the GPS jumps from side to side", () => {
  // 6.8 km/h; summed leg by leg, the zigzag would make it 11 km/h.
  assert.equal(aWay(1.9).mode, "walking");
  assert.equal(aWay(1.9, { reported: true }).mode, "walking", "the phone's own speed says the same");
  assert.equal(aWay(1.1, { jitterM: 20 }).mode, "walking");
});

test("a bike and a car keep their modes with the same wobbly GPS", () => {
  assert.equal(aWay(4.5, { everyS: 5, jitterM: 8 }).mode, "cycling");
  assert.equal(aWay(12, { metres: 5000, everyS: 5, jitterM: 8 }).mode, "driving");
});

test("waiting at a red light does not turn a drive into a ride by bike or a walk", () => {
  const points = [];
  for (let m = 0; m <= 20; m += 5) points.push(at(m, 48.1));
  // 3 km at about 36 km/h, with four minutes standing at a light halfway.
  for (let i = 1; i <= 5; i++) points.push(at(20 + i * 0.5, 48.1 + i * 0.0027));
  for (let m = 1; m <= 4; m++) points.push(at(22.5 + m, 48.1135 + (m % 2) * 0.00001));
  for (let i = 1; i <= 5; i++) points.push(at(26.5 + i * 0.5, 48.1135 + i * 0.0027));
  for (let m = 30; m <= 50; m += 5) points.push(at(m, 48.127));
  const trip = buildTimeline(points).segments.find((x) => x.type === "trip");
  assert.equal(trip.mode, "driving");
  assert.equal(trip.durationMs, 9 * MIN, "the trip still lasts as long as it did");
});

test("a stretch without fixes is a gap, it counts neither as distance nor as moving", () => {
  const points = [];
  for (let m = 0; m <= 30; m += 5) points.push(at(m, 48.1));
  // The phone went silent for hours and came back far away.
  for (let m = 300; m <= 330; m += 5) points.push(at(m, 48.3));
  const { segments, summary } = buildTimeline(points);
  assert.deepEqual(segments.map((seg) => seg.type + (seg.gap ? ":gap" : "")), ["visit", "trip:gap", "visit"]);
  assert.equal(summary.distanceM, 0);
  assert.equal(summary.movingMs, 0);
});

test("a way that goes silent halfway is split into the known part and a gap", () => {
  const points = [];
  for (let m = 0; m <= 20; m += 5) points.push(at(m, 48.1));
  for (let i = 1; i <= 5; i++) points.push(at(20 + i, 48.1 + i * 0.002));
  for (let m = 90; m <= 120; m += 5) points.push(at(m, 48.2));
  const { segments } = buildTimeline(points);
  assert.deepEqual(segments.map((seg) => seg.type + (seg.gap ? ":gap" : "")), ["visit", "trip", "trip:gap", "visit"]);
});

test("fixes that stay close together for a short time are no visit", () => {
  const points = [at(0, 48.1), at(1, 48.1), at(2, 48.1002), at(4, 48.1003)];
  const { segments } = buildTimeline(points);
  assert.equal(segments.filter((s) => s.type === "visit").length, 0);
});

test("a GPS jump is ignored", () => {
  const points = [];
  for (let m = 0; m <= 30; m += 5) points.push(at(m, 48.1));
  points.splice(3, 0, at(12, 52.5)); // 480 km away for a moment
  const { segments, summary } = buildTimeline(points);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, "visit");
  assert.equal(summary.pointCount, 7);
});

test("a short wobble between two stays at one place is one visit", () => {
  const points = [];
  for (let m = 0; m <= 20; m += 5) points.push(at(m, 48.1));
  points.push(at(22, 48.1018), at(24, 48.1018)); // about 200 m away for four minutes
  for (let m = 26; m <= 50; m += 5) points.push(at(m, 48.1));
  const { segments } = buildTimeline(points);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, "visit");
});

test("a dismissed stop is on the way: the trips on both sides become one", () => {
  const points = aDay();
  const there = buildTimeline(points).segments.filter((x) => x.type === "visit")[1];
  const { segments, summary } = buildTimeline(points, { dismissed: [{ start: there.start, end: there.end }] });
  assert.deepEqual(segments.map((x) => x.type), ["visit", "trip", "visit"]);
  assert.equal(summary.visits, 2);
  assert.ok(segments[1].path.some(([lat]) => Math.abs(lat - 48.16) < 0.001), "the trip runs through where the stop was");
  // A dismissed span elsewhere in the day changes nothing.
  assert.equal(buildTimeline(points, { dismissed: [{ start: DAY0 + 500 * MIN, end: DAY0 + 510 * MIN }] }).segments.length, 5);
});

test("an empty day has nothing to show", () => {
  const { segments, summary } = buildTimeline([]);
  assert.deepEqual(segments, []);
  assert.equal(summary.distanceM, 0);
});

test("dayRange follows the local calendar day", () => {
  assert.deepEqual(dayRange("2025-06-10", 0), { from: DAY0, to: DAY0 + 86_400_000 });
  // Berlin in summer is UTC+2, so getTimezoneOffset() is -120 and the day starts two hours earlier in UTC.
  assert.equal(dayRange("2025-06-10", -120).from, DAY0 - 2 * 60 * MIN);
  assert.equal(dayRange("not a date"), null);
});

let s;
beforeEach(async () => {
  s = await startServer();
});
afterEach(() => s.stop());

test("fixes are thinned out and read back for a day", async () => {
  const { user } = await s.account("luis");
  assert.equal(recordPosition(user.id, "phone", 48.1, 11.5, DAY0), true);
  assert.equal(recordPosition(user.id, "phone", 48.1, 11.5, DAY0 + 5_000), false, "too soon");
  assert.equal(recordPosition(user.id, "phone", 48.1, 11.5001, DAY0 + 30_000), false, "did not move");
  assert.equal(recordPosition(user.id, "phone", 48.11, 11.5, DAY0 + 60_000), true, "moved");
  assert.equal(recordPosition(user.id, "phone", 48.11, 11.5, DAY0 + 10 * MIN), true, "heartbeat");

  const rows = positionsBetween(user.id, "phone", DAY0, DAY0 + 86_400_000);
  assert.equal(rows.length, 3);
  assert.deepEqual(daysWithData(user.id, "phone", 0), ["2025-06-10"]);
});

test("old history is pruned", async () => {
  const { user } = await s.account("luis");
  recordPosition(user.id, "phone", 48.1, 11.5, DAY0);
  recordPosition(user.id, "phone", 48.2, 11.5, Date.now());
  assert.equal(pruneHistory(), 1);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM positions").get().n, 1);
});

test("the timeline endpoint returns the day of the signed-in account", async () => {
  const { user, cookie } = await s.account("luis");
  for (const p of aDay()) recordPosition(user.id, "phone", p.lat, p.lon, p.ts);

  const url = `${s.baseUrl}/api/timeline?deviceId=phone&date=2025-06-10&tz=0`;
  const res = await fetch(url, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.date, "2025-06-10");
  assert.deepEqual(body.segments.map((x) => x.type), ["visit", "trip", "visit", "trip", "visit"]);

  const days = await (await fetch(`${s.baseUrl}/api/timeline/days?deviceId=phone&tz=0`, { headers: { cookie } })).json();
  assert.deepEqual(days, ["2025-06-10"]);

  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`${s.baseUrl}/api/timeline?deviceId=phone&date=bad`, { headers: { cookie } })).status, 400);
});

test("a stop that was none can be dismissed and brought back", async () => {
  const { user, token } = await s.account("luis");
  for (const p of aDay()) recordPosition(user.id, "phone", p.lat, p.lon, p.ts);
  const headers = { "content-type": "application/json", ...deviceHeaders("phone", token) };
  const day = async () => (await fetch(`${s.baseUrl}/api/timeline?deviceId=phone&date=2025-06-10&tz=0`, { headers })).json();
  const put = (body) => fetch(`${s.baseUrl}/api/visits/dismissed`, { method: "PUT", headers, body: JSON.stringify(body) });

  const before = await day();
  assert.deepEqual(before.dismissed, []);
  const stop = before.segments.filter((x) => x.type === "visit")[1];

  assert.equal((await put({ deviceId: "phone", start: stop.start, end: stop.end, dismissed: true })).status, 204);
  const after = await day();
  assert.deepEqual(after.segments.map((x) => x.type), ["visit", "trip", "visit"]);
  assert.deepEqual(after.dismissed, [{ start: stop.start, end: stop.end }]);

  assert.equal((await put({ deviceId: "phone", start: stop.start, end: stop.end, dismissed: false })).status, 204);
  assert.equal((await day()).segments.length, 5);
  // Nothing left to bring back, no fix there, and an end before the start.
  assert.equal((await put({ deviceId: "phone", start: stop.start, end: stop.end, dismissed: false })).status, 404);
  assert.equal((await put({ deviceId: "phone", start: stop.start + 1, end: stop.end, dismissed: true })).status, 404);
  assert.equal((await put({ deviceId: "phone", start: stop.end, end: stop.start, dismissed: true })).status, 400);
});

test("another account cannot read the timeline", async () => {
  const luis = await s.account("luis");
  for (const p of aDay()) recordPosition(luis.user.id, "phone", p.lat, p.lon, p.ts);
  const { config } = await import("../src/config.js");
  const anna = await s.account("anna");

  const res = await fetch(`${s.baseUrl}/api/timeline?deviceId=phone&date=2025-06-10`, { headers: { cookie: anna.cookie } });
  assert.equal((await res.json()).segments.length, 0);
});

test("a device that reports its position builds history", async () => {
  const { user } = await s.account("luis");
  const phone = await s.device("luis", "phone");
  await phone.next();
  phone.send({ type: "updatePosition", latitude: 48.1, longitude: 11.5 });
  await phone.next();
  const rows = positionsBetween(user.id, "phone", 0, Date.now() + 1000);
  assert.equal(rows.length, 1);
});

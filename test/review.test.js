import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import {
  buildReview,
  createReviewJob,
  dayBounds,
  duePeriods,
  fixedZone,
  lastCompleted,
  namedZone,
  periodOf,
  reviewPushText,
  serverZone,
  simplifyPath,
} from "../src/review.js";
import { HOME, WORK, seedDay } from "./reviewFixture.js";
import { shareGroup, startServer } from "./helpers.js";

let s;
let transitBefore;
beforeEach(async () => {
  transitBefore = config.transit;
  config.transit = false;
  s = await startServer();
});
afterEach(async () => {
  config.transit = transitBefore;
  await s.stop();
});

const call = (method, route, body, cookie) =>
  fetch(s.baseUrl + route, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const getReview = async (cookie, query) => {
  const res = await call("GET", `/api/review?${query}`, undefined, cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};
const UTC = fixedZone(0);
const reviewRows = (userId) => Number(getDb().prepare("SELECT COUNT(*) AS n FROM review_days WHERE user_id = ?").get(userId).n);

// ---- periods ----

test("a week runs from Monday to Sunday, a month is the calendar month", () => {
  assert.deepEqual(periodOf("week", "2026-10-29"), { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(periodOf("week", "2026-10-26"), { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(periodOf("week", "2026-11-01"), { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(periodOf("week", "2027-01-01"), { from: "2026-12-28", to: "2027-01-03" });
  assert.deepEqual(periodOf("month", "2026-02-15"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodOf("month", "2028-02-29"), { from: "2028-02-01", to: "2028-02-29" });
  assert.deepEqual(periodOf("month", "2026-12-31"), { from: "2026-12-01", to: "2026-12-31" });
  // Without a date: the last one that is over.
  assert.deepEqual(lastCompleted("week", "2026-10-26"), { from: "2026-10-19", to: "2026-10-25" });
  assert.deepEqual(lastCompleted("week", "2026-10-25"), { from: "2026-10-12", to: "2026-10-18" });
  assert.deepEqual(lastCompleted("month", "2026-01-10"), { from: "2025-12-01", to: "2025-12-31" });
});

test("days follow the time zone, also where the clocks change", () => {
  // tz as from getTimezoneOffset(): Berlin in summer is -120, the day starts two hours before UTC midnight.
  const summer = dayBounds("2026-07-01", fixedZone(-120));
  assert.equal(summer.from, Date.UTC(2026, 6, 1) - 2 * 3_600_000);
  assert.equal(summer.to - summer.from, 86_400_000);
  assert.equal(fixedZone(-120).today(Date.UTC(2026, 6, 1, 23)), "2026-07-02");
  assert.equal(fixedZone(300).today(Date.UTC(2026, 6, 1, 3)), "2026-06-30");

  const berlin = namedZone("Europe/Berlin");
  assert.equal(berlin.offsetFor("2026-10-25"), -120);
  assert.equal(berlin.offsetFor("2026-10-26"), -60);
  const autumn = dayBounds("2026-10-25", berlin);
  assert.equal(autumn.from, Date.UTC(2026, 9, 24, 22));
  assert.equal(autumn.to - autumn.from, 25 * 3_600_000);
  const spring = dayBounds("2026-03-29", berlin);
  assert.equal(spring.to - spring.from, 23 * 3_600_000);
  // The week with the change is 169 hours long and its days fit together without a gap.
  const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"].map((d) => dayBounds(d, berlin));
  for (let i = 1; i < days.length; i++) assert.equal(days[i].from, days[i - 1].to);
  assert.equal(days[6].to - days[0].from, (7 * 24 + 1) * 3_600_000);
  assert.throws(() => namedZone("Mars/Olympus"), RangeError);

  // The server's zone agrees with the Date of this process.
  const local = dayBounds("2026-10-25", serverZone);
  assert.equal(local.from, new Date(2026, 9, 25).getTime());
  assert.equal(local.to, new Date(2026, 9, 26).getTime());
});

test("a long path is thinned to the limit and keeps its ends", () => {
  const line = Array.from({ length: 5000 }, (_, i) => [52 + i * 0.0001, 13 + Math.sin(i / 20) * 0.001]);
  const thin = simplifyPath(line, 600);
  assert.ok(thin.length <= 600 && thin.length > 10);
  assert.deepEqual(thin[0], line[0]);
  assert.deepEqual(thin.at(-1), line.at(-1));
  assert.equal(simplifyPath(line.slice(0, 5), 600).length, 5);
});

// ---- aggregation ----

test("the review adds up the days of the own timeline: distance, time, modes, places, days and path", async () => {
  const luis = await s.account("luis");
  const id = luis.user.id;
  seedDay(id, "phone", "2026-10-20", UTC);
  seedDay(id, "phone", "2026-10-22", UTC);
  for (const body of [{ lat: HOME.lat, lon: HOME.lon, kind: "home" }, { lat: WORK.lat, lon: WORK.lon, name: "Office" }]) {
    assert.equal((await call("POST", "/api/places", body, luis.cookie)).status, 200);
  }

  const review = await getReview(luis.cookie, "period=week&date=2026-10-21&tz=0");
  assert.equal(review.period, "week");
  assert.equal(review.from, "2026-10-19");
  assert.equal(review.to, "2026-10-25");
  assert.equal(review.empty, false);

  // The same as the two timelines say.
  let metres = 0;
  let movingMs = 0;
  let stops = 0;
  for (const date of ["2026-10-20", "2026-10-22"]) {
    const day = await (await call("GET", `/api/timeline?deviceId=phone&date=${date}&tz=0`, undefined, luis.cookie)).json();
    metres += day.summary.distanceM;
    movingMs += day.summary.movingMs;
    stops += day.summary.visits;
  }
  assert.equal(review.distanceKm, Math.round(metres / 100) / 10);
  assert.equal(review.movingMinutes, Math.round(movingMs / 60_000));
  assert.equal(review.stops, stops);
  assert.equal(review.trips, 4);
  assert.ok(review.distanceKm > 5 && review.distanceKm < 7, `${review.distanceKm} km`);

  assert.deepEqual(Object.keys(review.byMode), ["walking", "cycling", "driving", "transit"]);
  assert.ok(review.byMode.walking.km > 2.5 && review.byMode.walking.minutes >= 30);
  assert.ok(review.byMode.driving.km > 2.5 && review.byMode.driving.minutes <= 5);
  assert.deepEqual(review.byMode.cycling, { km: 0, minutes: 0 });
  assert.deepEqual(review.transit, []);

  assert.deepEqual(
    review.topPlaces.map((p) => [p.name, p.kind, p.visits]),
    [
      ["Home", "home", 4],
      ["Office", "place", 2],
    ]
  );
  assert.ok(review.topPlaces[1].minutes > 2 * 8 * 60);
  assert.equal(review.newPlaces, 2);

  assert.deepEqual(
    review.days.map((d) => d.date),
    ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]
  );
  assert.equal(review.days[0].km, 0);
  assert.ok(review.days[1].km > 2.5 && review.days[1].movingMinutes > 15);
  assert.ok(review.path.length > 10 && review.path.length <= 600);
  assert.ok(review.path.every((p) => p.length === 2));
  assert.equal(review.previous, null);

  // The next week compares with this one, and knows the places already.
  seedDay(id, "phone", "2026-10-27", UTC);
  const next = await getReview(luis.cookie, "period=week&date=2026-10-27&tz=0");
  assert.deepEqual(next.previous, { distanceKm: review.distanceKm, movingMinutes: review.movingMinutes });
  assert.equal(next.newPlaces, 0);

  // The month holds all three days.
  const month = await getReview(luis.cookie, "period=month&date=2026-10-01&tz=0");
  assert.equal(month.from, "2026-10-01");
  assert.equal(month.to, "2026-10-31");
  assert.equal(month.days.length, 31);
  assert.equal(month.trips, 6);
});

test("a period without fixes is empty, and the default is the last finished week", async () => {
  const luis = await s.account("luis");
  const review = await getReview(luis.cookie, "tz=0");
  assert.deepEqual(review, { ...lastCompleted("week", UTC.today(Date.now())), ...emptyShape(review) });
  assert.equal(review.empty, true);
  assert.equal(review.days.length, 7);
  const month = await getReview(luis.cookie, "period=month&tz=0");
  assert.equal(month.days.length, Number(month.to.slice(8)));
  assert.equal(month.from.slice(8), "01");
});

function emptyShape(review) {
  return {
    period: "week",
    distanceKm: 0,
    movingMinutes: 0,
    trips: 0,
    stops: 0,
    byMode: { walking: { km: 0, minutes: 0 }, cycling: { km: 0, minutes: 0 }, driving: { km: 0, minutes: 0 }, transit: { km: 0, minutes: 0 } },
    transit: [],
    topPlaces: [],
    newPlaces: 0,
    days: review.days.map((d) => ({ date: d.date, km: 0, movingMinutes: 0 })),
    path: [],
    previous: null,
    empty: true,
  };
}

test("each day counts the device with the most fixes", async () => {
  const luis = await s.account("luis");
  seedDay(luis.user.id, "phone", "2026-10-20", UTC);
  // The tablet at home sends a fix every ten minutes, far fewer.
  const insert = getDb().prepare("INSERT INTO positions (user_id, device_id, ts, lat, lon) VALUES (?, 'tablet', ?, ?, ?)");
  const { from } = dayBounds("2026-10-20", UTC);
  for (let ts = from; ts < from + 86_400_000; ts += 10 * 60_000) insert.run(luis.user.id, ts, HOME.lat + 0.05, HOME.lon);
  const review = await getReview(luis.cookie, "period=week&date=2026-10-20&tz=0");
  assert.equal(review.trips, 2);
});

test("ride lines are counted with their colours", async () => {
  const luis = await s.account("luis");
  const id = luis.user.id;
  seedDay(id, "phone", "2026-10-20", UTC);
  const day = await (await call("GET", "/api/timeline?deviceId=phone&date=2026-10-20&tz=0", undefined, luis.cookie)).json();
  const drive = day.segments.find((x) => x.type === "trip" && x.mode === "driving");
  // A stored match, as the timetables leave it.
  const transit = { kind: "bus", line: "M41", headsign: null, color: "#a3007c", textColor: null, agency: null, from: { name: "A", lat: 0, lon: 0 }, to: { name: "B", lat: 0, lon: 0 }, source: "gtfs" };
  config.transit = true;
  getDb()
    .prepare("INSERT INTO trip_transit (user_id, device_id, start, end_ms, transit, path, data_stamp) VALUES (?, 'phone', ?, ?, ?, NULL, 0)")
    .run(id, drive.start, drive.end, JSON.stringify(transit));
  const review = await getReview(luis.cookie, "period=week&date=2026-10-20&tz=0");
  assert.deepEqual(review.transit, [{ kind: "bus", line: "M41", color: "#a3007c", rides: 1 }]);
  assert.ok(review.byMode.transit.km > 1);
  assert.equal(review.byMode.driving.km, 0);
});

// ---- the store ----

test("finished days are stored and built again when their fixes, stops, corrections or places change", async () => {
  const luis = await s.account("luis");
  const id = luis.user.id;
  seedDay(id, "phone", "2026-10-20", UTC);
  const query = "period=week&date=2026-10-20&tz=0";
  const first = await getReview(luis.cookie, query);
  // Only days with fixes need a row.
  assert.equal(reviewRows(id), 1);
  const storedData = () => getDb().prepare("SELECT data FROM review_days WHERE user_id = ? AND date = '2026-10-20'").get(id).data;
  const before = storedData();
  assert.deepEqual(await getReview(luis.cookie, query), first);
  assert.equal(storedData(), before);

  // A stored day is what comes back, as long as nothing it was made of changed.
  getDb().prepare("UPDATE review_days SET data = json_set(data, '$.trips', 99) WHERE user_id = ? AND date = '2026-10-20'").run(id);
  assert.equal((await getReview(luis.cookie, query)).trips, 99);
  getDb().prepare("UPDATE review_days SET data = ? WHERE user_id = ? AND date = '2026-10-20'").run(before, id);

  // Dismissing the stop at work makes the walk and the drive one trip.
  const day = await (await call("GET", "/api/timeline?deviceId=phone&date=2026-10-20&tz=0", undefined, luis.cookie)).json();
  const work = day.segments.find((x) => x.type === "visit" && Math.abs(x.lat - WORK.lat) < 0.001);
  assert.equal((await call("PUT", "/api/visits/dismissed", { deviceId: "phone", start: work.start, end: work.end, dismissed: true }, luis.cookie)).status, 204);
  const dismissed = await getReview(luis.cookie, query);
  assert.equal(dismissed.stops, first.stops - 1);
  assert.equal(dismissed.trips, 1);
  assert.equal((await call("PUT", "/api/visits/dismissed", { deviceId: "phone", start: work.start, end: work.end, dismissed: false }, luis.cookie)).status, 204);
  assert.deepEqual(await getReview(luis.cookie, query), first);

  // "That was by bike."
  const walk = day.segments.find((x) => x.type === "trip" && x.mode === "walking");
  assert.equal((await call("PUT", "/api/trips/mode", { deviceId: "phone", start: walk.start, mode: "cycling" }, luis.cookie)).status, 204);
  const corrected = await getReview(luis.cookie, query);
  assert.equal(corrected.byMode.walking.km, 0);
  assert.equal(corrected.byMode.cycling.km, first.byMode.walking.km);

  // Naming the place.
  assert.deepEqual(corrected.topPlaces, []);
  const saved = await call("POST", "/api/places", { lat: WORK.lat, lon: WORK.lon, name: "Office" }, luis.cookie);
  assert.equal((await getReview(luis.cookie, query)).topPlaces[0]?.name, "Office");
  const place = await saved.json();
  assert.equal((await call("PATCH", `/api/places/${place.id}`, { name: "Studio" }, luis.cookie)).status, 200);
  assert.equal((await getReview(luis.cookie, query)).topPlaces[0]?.name, "Studio");

  // A fix sent in late for that day.
  const { from } = dayBounds("2026-10-20", UTC);
  getDb().prepare("INSERT INTO positions (user_id, device_id, ts, lat, lon) VALUES (?, 'phone', ?, ?, ?)").run(id, from + 23.95 * 3_600_000, HOME.lat + 0.02, HOME.lon);
  assert.ok((await getReview(luis.cookie, query)).distanceKm > corrected.distanceKm);
});

test("today and days still waiting for place names are not stored", async () => {
  const luis = await s.account("luis");
  const id = luis.user.id;
  const today = UTC.today(Date.now());
  seedDay(id, "phone", today, UTC);
  await getReview(luis.cookie, `period=week&date=${today}&tz=0`);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM review_days WHERE user_id = ? AND date = ?").get(id, today).n, 0);
});

test("invisible times count in the own review, as in the own timeline", async () => {
  const luis = await s.account("luis");
  seedDay(luis.user.id, "phone", "2026-10-20", UTC);
  const visible = await getReview(luis.cookie, "period=week&date=2026-10-20&tz=0");
  const { from, to } = dayBounds("2026-10-20", UTC);
  getDb().prepare("INSERT INTO hidden_spans (user_id, start, end_ms) VALUES (?, ?, ?)").run(luis.user.id, from, to);
  getDb().prepare("DELETE FROM review_days").run();
  assert.deepEqual(await getReview(luis.cookie, "period=week&date=2026-10-20&tz=0"), visible);
});

// ---- rights and input ----

test("only the own review, the admin reads anyone's with userId", async () => {
  const boss = await s.account("boss");
  getDb().prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(boss.user.id);
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  seedDay(luis.user.id, "phone", "2026-10-20", UTC);
  const own = await getReview(luis.cookie, "period=week&date=2026-10-20&tz=0");

  // A shared timeline does not share the review.
  shareGroup("Family", luis.user, anna.user);
  assert.equal((await call("PUT", "/api/timeline/sharing", { mode: "groups", users: [], groups: [] }, luis.cookie)).status, 200);
  assert.equal((await call("GET", `/api/review?date=2026-10-20&tz=0&userId=${luis.user.id}`, undefined, anna.cookie)).status, 403);

  assert.deepEqual(await getReview(boss.cookie, `period=week&date=2026-10-20&tz=0&userId=${luis.user.id}`), own);
  assert.equal((await getReview(boss.cookie, "period=week&date=2026-10-20&tz=0")).empty, true);
  assert.equal((await call("GET", "/api/review?userId=999", undefined, boss.cookie)).status, 404);
  assert.equal((await call("GET", "/api/review?userId=999", undefined, luis.cookie)).status, 403);
  assert.equal((await fetch(`${s.baseUrl}/api/review`)).status, 401);
});

test("the app asks with its device token", async () => {
  const luis = await s.account("luis");
  const res = await fetch(`${s.baseUrl}/api/review?period=month&tz=-60`, {
    headers: { "x-device-id": "phone", authorization: `Bearer ${luis.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).period, "month");
});

test("wrong dates, periods and zones answer 400", async () => {
  const luis = await s.account("luis");
  for (const query of ["date=2026-02-30", "date=yesterday", "period=year", "timeZone=Mars/Olympus", "tz=5000"]) {
    assert.equal((await call("GET", `/api/review?${query}`, undefined, luis.cookie)).status, 400, query);
  }
  const named = await getReview(luis.cookie, "date=2026-10-20&timeZone=Europe/Berlin");
  assert.equal(named.from, "2026-10-19");
});

// ---- notifications ----

const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test("reviews are due on Monday from nine, months on the first", () => {
  // 2026-10-26 is a Monday, 2026-06-01 a Monday and the first.
  assert.deepEqual(duePeriods(at(2026, 10, 26, 8, 59)), []);
  assert.deepEqual(duePeriods(at(2026, 10, 26, 9, 0)), [{ period: "week", from: "2026-10-19", to: "2026-10-25" }]);
  assert.deepEqual(duePeriods(at(2026, 10, 26, 23, 30)), [{ period: "week", from: "2026-10-19", to: "2026-10-25" }]);
  assert.deepEqual(duePeriods(at(2026, 10, 27, 9, 0)), []);
  assert.deepEqual(duePeriods(at(2026, 10, 1, 9, 0)), [{ period: "month", from: "2026-09-01", to: "2026-09-30" }]);
  assert.deepEqual(duePeriods(at(2026, 6, 1, 10, 0)), [
    { period: "week", from: "2026-05-25", to: "2026-05-31" },
    { period: "month", from: "2026-05-01", to: "2026-05-31" },
  ]);
  assert.deepEqual(reviewPushText({ period: "week", from: "2026-10-19", to: "2026-10-25", distanceKm: 84.4, movingMinutes: 362 }), {
    title: "Your week: 84 km, 6 h on the move",
    body: "Your review of 19 Oct – 25 Oct is ready",
  });
  assert.equal(reviewPushText({ period: "month", from: "2026-10-01", to: "2026-10-31", distanceKm: 3.2, movingMinutes: 45 }).title, "Your month: 3.2 km, 45 min on the move");
});

test("the Monday review goes once to every account with data, unless turned off", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const ben = await s.account("ben");
  seedDay(luis.user.id, "phone", "2026-10-21", serverZone);
  seedDay(ben.user.id, "phone", "2026-10-21", serverZone);
  const luisSocket = await s.device("luis", "phone2");

  // Ben does not want it.
  assert.deepEqual(await (await call("GET", "/api/me/review-notifications", undefined, ben.cookie)).json(), { enabled: true });
  const off = await call("PUT", "/api/me/review-notifications", { enabled: false }, ben.cookie);
  assert.deepEqual(await off.json(), { enabled: false });
  assert.deepEqual(await (await call("GET", "/api/me/review-notifications", undefined, ben.cookie)).json(), { enabled: false });
  assert.equal((await call("PUT", "/api/me/review-notifications", { enabled: "no" }, ben.cookie)).status, 400);

  assert.deepEqual(await s.server.sendDueReviews(at(2026, 10, 26, 8, 30)), []);
  const told = await s.server.sendDueReviews(at(2026, 10, 26, 9, 1));
  assert.deepEqual(told, [luis.user.id]);
  let message;
  do message = await luisSocket.next();
  while (message.type !== "notificationsChanged");

  const list = await (await call("GET", "/api/notifications", undefined, luis.cookie)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].type, "review");
  const review = await buildReview(luis.user.id, { period: "week", date: "2026-10-19", zone: serverZone });
  assert.deepEqual(list[0].data, { period: "week", from: "2026-10-19", to: "2026-10-25", distanceKm: review.distanceKm });
  assert.deepEqual(await (await call("GET", "/api/notifications", undefined, anna.cookie)).json(), []);
  assert.deepEqual(await (await call("GET", "/api/notifications", undefined, ben.cookie)).json(), []);

  // Later that day, and after a restart: nothing again.
  assert.deepEqual(await s.server.sendDueReviews(at(2026, 10, 26, 12, 0)), []);
  const restarted = createReviewJob();
  assert.deepEqual(await restarted.run(at(2026, 10, 26, 12, 5)), []);
  restarted.stop();
  assert.equal((await (await call("GET", "/api/notifications", undefined, luis.cookie)).json()).length, 1);

  // The first of the month brings the month, with the week only when that day is a Monday.
  const month = await s.server.sendDueReviews(at(2026, 11, 1, 9, 0));
  assert.deepEqual(month, [luis.user.id]);
  const latest = (await (await call("GET", "/api/notifications", undefined, luis.cookie)).json())[0];
  assert.deepEqual(latest.data, { period: "month", from: "2026-10-01", to: "2026-10-31", distanceKm: review.distanceKm });
});

test("two runs at the same time send once", async () => {
  const luis = await s.account("luis");
  seedDay(luis.user.id, "phone", "2026-10-21", serverZone);
  const now = at(2026, 10, 26, 9, 0);
  const [a, b] = await Promise.all([s.server.sendDueReviews(now), s.server.sendDueReviews(now)]);
  assert.deepEqual(a, [luis.user.id]);
  assert.equal(a, b);
  assert.equal((await (await call("GET", "/api/notifications", undefined, luis.cookie)).json()).length, 1);
});

// ---- speed ----

test("a month of dense fixes answers quickly once its days are stored", async (t) => {
  const luis = await s.account("luis");
  let fixes = 0;
  for (let day = 1; day <= 30; day++) fixes += seedDay(luis.user.id, "phone", `2026-09-${String(day).padStart(2, "0")}`, UTC, { dense: true });
  const query = "period=month&date=2026-09-15&tz=0";
  let started = performance.now();
  const cold = await getReview(luis.cookie, query);
  const coldMs = performance.now() - started;
  started = performance.now();
  const warm = await getReview(luis.cookie, query);
  const warmMs = performance.now() - started;
  t.diagnostic(`${fixes} fixes: first ${Math.round(coldMs)} ms, stored ${Math.round(warmMs)} ms`);
  assert.deepEqual(warm, cold);
  assert.equal(cold.trips, 60);
  assert.ok(cold.path.length <= 600);
  assert.ok(warmMs < 300, `${warmMs} ms`);
});

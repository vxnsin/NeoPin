import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HIDDEN_FOREVER, hiddenSpans } from "../src/accounts.js";
import { getDb } from "../src/db.js";
import { createGroup, removeMember } from "../src/groups.js";
import { recordPosition } from "../src/history.js";
import { shareGroup, startServer } from "./helpers.js";

const MIN = 60_000;
const DAY = "2025-06-10";
const DAY0 = Date.UTC(2025, 5, 10);
const A = { lat: 48.1, lon: 11.5 };
// About 2.2 km north of A.
const B = { lat: 48.12, lon: 11.5 };

let s;
beforeEach(async () => {
  s = await startServer();
});
afterEach(() => s.stop());

const call = (method, route, body, who) =>
  fetch(s.baseUrl + route, {
    method,
    headers: { "content-type": "application/json", ...(who ? { cookie: who.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (res) => {
  assert.ok(res.ok, `status ${res.status}`);
  return res.json();
};

// 08:00 to 08:30 at A, on the way until 08:45, at B until 09:30.
function aDay(userId, day0 = DAY0) {
  const at = (h, m) => day0 + (h * 60 + m) * MIN;
  for (let m = 0; m <= 30; m += 5) recordPosition(userId, "phone", A.lat, A.lon, at(8, m));
  for (let m = 31; m < 45; m++) {
    const f = (m - 30) / 15;
    recordPosition(userId, "phone", A.lat + (B.lat - A.lat) * f, A.lon, at(8, m));
  }
  for (let m = 45; m <= 90; m += 5) recordPosition(userId, "phone", B.lat, B.lon, at(8, m));
}

const timelineOf = (owner, who) => call("GET", `/api/timeline?deviceId=phone&date=${DAY}&tz=0&userId=${owner.user.id}`, undefined, who);
const daysOf = (owner, who) => call("GET", `/api/timeline/days?deviceId=phone&tz=0&userId=${owner.user.id}`, undefined, who);
const share = (who, body) => call("PUT", "/api/timeline/sharing", { users: [], groups: [], ...body }, who);

// Everybody of the access tests: the admin (the first account), the owner, two people who share
// a different group with the owner each, and one who shares none.
async function people() {
  const boss = await s.account("boss");
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const tom = await s.account("tom");
  const eve = await s.account("eve");
  const family = shareGroup("Family", luis.user, anna.user);
  const club = shareGroup("Club", luis.user, tom.user);
  aDay(luis.user.id);
  return { boss, luis, anna, tom, eve, family, club };
}

async function readable(owner, who) {
  const [day, days] = await Promise.all([timelineOf(owner, who), daysOf(owner, who)]);
  assert.equal(day.status, days.status, "the day and the days answer alike");
  return day.status;
}

test("sharing settings: off by default, only people and groups that share a group", async () => {
  const { luis, anna, eve, family } = await people();
  const evesGroup = createGroup(eve.user.id, "Eve's");
  assert.equal((await call("GET", "/api/timeline/sharing")).status, 401);
  assert.deepEqual(await json(await call("GET", "/api/timeline/sharing", undefined, luis)), { mode: "off", users: [], groups: [] });

  const wanted = { mode: "selected", users: [anna.user.id], groups: [family.id] };
  assert.deepEqual(await json(await share(luis, wanted)), wanted);
  assert.deepEqual(await json(await call("GET", "/api/timeline/sharing", undefined, luis)), wanted);
  // Other modes keep the picks for later.
  assert.deepEqual(await json(await share(luis, { ...wanted, mode: "off" })), { ...wanted, mode: "off" });

  for (const body of [
    { mode: "selected", users: [eve.user.id] },
    { mode: "selected", users: [luis.user.id] },
    { mode: "selected", groups: [evesGroup.id] },
    { mode: "everyone" },
  ]) {
    assert.equal((await share(luis, body)).status, 400, JSON.stringify(body));
  }
});

test("who may read a timeline: self, the admin, and whoever the owner shares it with", async () => {
  const { boss, luis, anna, tom, eve, family, club } = await people();

  // Off: the owner and the admin only.
  assert.equal(await readable(luis, luis), 200);
  assert.equal(await readable(luis, boss), 200);
  for (const who of [anna, tom, eve]) assert.equal(await readable(luis, who), 403);

  // Everyone in my groups.
  await share(luis, { mode: "groups" });
  assert.equal(await readable(luis, anna), 200);
  assert.equal(await readable(luis, tom), 200);
  assert.equal(await readable(luis, eve), 403);

  // Chosen people: Anna by name.
  await share(luis, { mode: "selected", users: [anna.user.id] });
  assert.equal(await readable(luis, anna), 200);
  assert.equal(await readable(luis, tom), 403);

  // Chosen groups: the Club.
  await share(luis, { mode: "selected", groups: [club.id] });
  assert.equal(await readable(luis, tom), 200);
  assert.equal(await readable(luis, anna), 403);

  // Leaving the group ends it, also for someone chosen by name.
  await share(luis, { mode: "selected", users: [anna.user.id], groups: [club.id] });
  removeMember(club.id, tom.user.id);
  removeMember(family.id, anna.user.id);
  assert.equal(await readable(luis, tom), 403);
  assert.equal(await readable(luis, anna), 403);

  // Nobody learns whether an account exists, except the admin.
  assert.equal((await call("GET", `/api/timeline/days?deviceId=phone&userId=9999`, undefined, anna)).status, 403);
  assert.equal((await call("GET", `/api/timeline/days?deviceId=phone&userId=9999`, undefined, boss)).status, 404);
});

test("a shared timeline is for reading: places, corrections and dismissed stops stay with the owner", async () => {
  const { boss, luis, anna } = await people();
  await share(luis, { mode: "groups" });
  const day = await json(await timelineOf(luis, anna));
  assert.deepEqual(day.segments.map((x) => x.type), ["visit", "trip", "visit"]);
  const [visit, trip] = day.segments;
  const q = `?userId=${luis.user.id}`;
  assert.equal((await call("PUT", `/api/trips/mode${q}`, { deviceId: "phone", start: trip.start, mode: "driving" }, anna)).status, 403);
  assert.equal((await call("PUT", `/api/visits/dismissed${q}`, { deviceId: "phone", start: visit.start, end: visit.end, dismissed: true }, anna)).status, 403);
  assert.equal((await call("POST", `/api/places${q}`, { lat: A.lat, lon: A.lon, kind: "home" }, anna)).status, 403);
  assert.equal((await call("GET", `/api/places${q}`, undefined, anna)).status, 403);
  // The admin still may.
  assert.equal((await call("PUT", `/api/trips/mode${q}`, { deviceId: "phone", start: trip.start, mode: "driving" }, boss)).status, 204);
});

test("the people list has myself first and everyone whose timeline I may read, with their devices", async () => {
  const { boss, luis, anna, tom, eve } = await people();
  const ids = async (who) => (await json(await call("GET", "/api/timeline/people", undefined, who))).map((p) => p.userId);

  assert.deepEqual(await ids(anna), [anna.user.id]);
  await share(luis, { mode: "groups" });
  const list = await json(await call("GET", "/api/timeline/people", undefined, anna));
  assert.deepEqual(list, [
    { userId: anna.user.id, displayName: "anna", avatarUrl: null, devices: ["phone"] },
    { userId: luis.user.id, displayName: "luis", avatarUrl: null, devices: ["phone"] },
  ]);
  assert.deepEqual(await ids(eve), [eve.user.id]);
  // The admin reads everyone, by name after itself.
  assert.deepEqual(await ids(boss), [boss.user.id, anna.user.id, eve.user.id, luis.user.id, tom.user.id]);
  assert.equal((await call("GET", "/api/timeline/people")).status, 401);
});

test("hiding is kept as spans: from switching it on until it ends or is switched off", async () => {
  const luis = await s.account("luis");
  const spans = () => hiddenSpans(luis.user.id, 0, HIDDEN_FOREVER + 1);
  const before = Date.now();
  await call("PUT", "/api/me/hidden", { minutes: 30 }, luis);
  const [first] = spans();
  assert.ok(first.start >= before && first.start <= Date.now());
  assert.ok(Math.abs(first.end - (first.start + 30 * MIN)) < 1000);

  // Until I turn it off: the running span ends now, a new one starts.
  await call("PUT", "/api/me/hidden", {}, luis);
  const [closed, forever] = spans();
  assert.ok(closed.end <= Date.now() && closed.end >= first.start);
  assert.equal(forever.end, HIDDEN_FOREVER);

  await call("DELETE", "/api/me/hidden", undefined, luis);
  const after = spans();
  assert.equal(after.length, 2);
  assert.ok(after[1].end <= Date.now(), "switched off, the span ends");
});

test("what happened while the owner was invisible is only for the owner and the admin", async () => {
  const { boss, luis, anna } = await people();
  await share(luis, { mode: "groups" });
  const at = (day0, h, m) => day0 + (h * 60 + m) * MIN;
  // Invisible from 08:40 to 10:00, and for the whole of the next day.
  const day1 = DAY0 + 86_400_000;
  aDay(luis.user.id, day1);
  const insert = getDb().prepare("INSERT INTO hidden_spans (user_id, start, end_ms) VALUES (?, ?, ?)");
  insert.run(luis.user.id, at(DAY0, 8, 40), at(DAY0, 10, 0));
  insert.run(luis.user.id, day1, day1 + 86_400_000);
  // A stop dismissed inside the span.
  getDb()
    .prepare("INSERT INTO dismissed_visits (user_id, device_id, start, end_ms) VALUES (?, 'phone', ?, ?)")
    .run(luis.user.id, at(DAY0, 9, 0), at(DAY0, 9, 10));

  for (const who of [luis, boss]) {
    const day = await json(await timelineOf(luis, who));
    assert.equal(day.summary.pointCount, 7 + 14 + 10);
    assert.deepEqual(day.dismissed, [{ start: at(DAY0, 9, 0), end: at(DAY0, 9, 10) }]);
    assert.deepEqual(await json(await daysOf(luis, who)), ["2025-06-11", "2025-06-10"]);
  }

  const shared = await json(await timelineOf(luis, anna));
  assert.ok(shared.segments.length > 0);
  for (const seg of shared.segments) assert.ok(seg.end < at(DAY0, 8, 40), `${seg.type} ends before the span`);
  assert.equal(shared.summary.pointCount, 7 + 9, "the stay at A and the way until 08:39");
  assert.deepEqual(shared.dismissed, []);
  assert.deepEqual(await json(await daysOf(luis, anna)), ["2025-06-10"], "a day spent invisible has nothing to show");
});

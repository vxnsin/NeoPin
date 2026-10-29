import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createGroup, removeMember } from "../src/groups.js";
import { savePlaceAt } from "../src/places.js";
import { setPushToken } from "../src/push.js";
import { sentCount, startFakeFcm } from "./fakeFcm.js";
import { shareGroup, startServer } from "./helpers.js";

const MIN = 60_000;
const HOME = { lat: 49.79, lon: 9.93 };
// About 1.1 km north of home.
const AWAY = { lat: 49.8, lon: 9.93 };

let s;
let fake = null;
let t0;
beforeEach(async () => {
  s = await startServer();
  // The fixes are from the last hours: the server takes the phone's time only that far back.
  t0 = Date.now() - 3 * 60 * MIN;
});
afterEach(async () => {
  await fake?.stop();
  fake = null;
  await s.stop();
});

const call = (method, route, body, who) =>
  fetch(s.baseUrl + route, {
    method,
    headers: { "content-type": "application/json", ...(who ? { cookie: who.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const notifications = async (who) => (await call("GET", "/api/notifications", undefined, who)).json();

// Messages are handled in order: once the pong is back, every fix before it is in.
async function sync(client) {
  client.send({ type: "ping" });
  while ((await client.next()).type !== "pong");
}

// [place, minute after t0] per fix.
async function report(client, fixes) {
  for (const [where, minute] of fixes) {
    client.send({ type: "updatePosition", latitude: where.lat, longitude: where.lon, recordedAt: Math.round(t0 + minute * MIN) });
  }
  await sync(client);
}

const homeOf = (who) => savePlaceAt(who.user.id, { ...HOME, kind: "home" });

test("alert settings: home and work by default, own places, people and groups that share a group only", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const tom = await s.account("tom");
  const family = shareGroup("Family", luis.user, anna.user);
  const toms = createGroup(tom.user.id, "Tom's");
  const home = homeOf(luis);
  const work = savePlaceAt(luis.user.id, { lat: 49.8, lon: 9.95, kind: "work" });
  const cafe = savePlaceAt(luis.user.id, { lat: 49.81, lon: 9.96, name: "Café Mohr", kind: "cafe" });
  const tomsHome = homeOf(tom);

  assert.equal((await call("GET", "/api/alerts")).status, 401);
  assert.deepEqual(await (await call("GET", "/api/alerts", undefined, luis)).json(), {
    places: [home.id, work.id].sort((a, b) => a - b),
    recipients: { users: [], groups: [] },
  });

  const wanted = { places: [cafe.id, home.id], recipients: { users: [anna.user.id], groups: [family.id] } };
  const saved = await call("PUT", "/api/alerts", wanted, luis);
  assert.equal(saved.status, 200);
  const expected = { places: [home.id, cafe.id].sort((a, b) => a - b), recipients: wanted.recipients };
  assert.deepEqual(await saved.json(), expected);
  assert.deepEqual(await (await call("GET", "/api/alerts", undefined, luis)).json(), expected);

  const refused = [
    { places: [tomsHome.id], recipients: { users: [], groups: [] } },
    { places: [], recipients: { users: [tom.user.id], groups: [] } },
    { places: [], recipients: { users: [luis.user.id], groups: [] } },
    { places: [], recipients: { users: [], groups: [toms.id] } },
    { places: [], recipients: { users: [], groups: [9999] } },
  ];
  for (const body of refused) assert.equal((await call("PUT", "/api/alerts", body, luis)).status, 400, JSON.stringify(body));
  assert.equal((await call("PUT", "/api/alerts", { places: "all" }, luis)).status, 400);
  assert.deepEqual(await (await call("GET", "/api/alerts", undefined, luis)).json(), expected, "a refused setup changes nothing");

  // Nothing chosen stays nothing, the default is only for those who never saved.
  await call("PUT", "/api/alerts", { places: [], recipients: { users: [], groups: [] } }, luis);
  assert.deepEqual((await (await call("GET", "/api/alerts", undefined, luis)).json()).places, []);
});

test("arriving and leaving notify the chosen people once per person, with a push to Android phones", async () => {
  fake = await startFakeFcm();
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const tom = await s.account("tom");
  shareGroup("Family", luis.user, anna.user, tom.user);
  const home = homeOf(luis);
  setPushToken(anna.user.id, "phone", "anna-fcm", "android");
  setPushToken(tom.user.id, "phone", "tom-fcm", "ios");
  setPushToken(luis.user.id, "phone", "luis-fcm", "android");
  await call("PUT", "/api/alerts", { places: [home.id], recipients: { users: [anna.user.id, tom.user.id], groups: [] } }, luis);

  const annaPhone = await s.device("anna", "phone");
  const phone = await s.device("luis", "phone");
  const tablet = await s.device("luis", "tablet");

  // The first fixes only tell the server where the phone is: away, nothing to report.
  await report(phone, [[AWAY, 0], [AWAY, 1]]);
  await report(tablet, [[AWAY, 2], [AWAY, 3]]);
  // One fix at home is no arrival yet, nor is a second one a minute later.
  await report(phone, [[HOME, 10], [HOME, 11]]);
  assert.deepEqual(await notifications(anna), []);
  await report(phone, [[HOME, 12]]);

  for (let i = 0; i < 20; i++) if ((await annaPhone.next()).type === "notificationsChanged") break;
  const [arrived] = await notifications(anna);
  assert.equal(arrived.type, "arrived");
  assert.equal(arrived.readAt, null);
  assert.deepEqual(arrived.data, { userId: luis.user.id, name: "luis", placeId: home.id, placeName: "Home", kind: "home", at: Math.round(t0 + 12 * MIN) });
  assert.equal((await notifications(tom)).length, 1, "an iPhone reads it in the list");
  assert.deepEqual(await notifications(luis), [], "never the person themselves");

  assert.equal(await sentCount(fake, 1), 1);
  const clock = new Date(arrived.data.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  assert.equal(fake.sent[0].token, "anna-fcm");
  assert.deepEqual(fake.sent[0].notification, { title: "luis arrived at Home", body: `Arrived at ${clock}` });
  assert.deepEqual(fake.sent[0].data, { type: "arrived", userId: String(luis.user.id), placeId: String(home.id), at: String(arrived.data.at) });

  // The tablet coming home too is the same person arriving.
  await report(tablet, [[HOME, 12.5], [HOME, 14.6]]);
  assert.equal((await notifications(anna)).length, 1);

  // Leaving: two fixes away, the later one at least three minutes after the last at home.
  await report(phone, [[HOME, 21], [AWAY, 22], [AWAY, 23]]);
  assert.equal((await notifications(anna)).length, 1, "only two minutes since the last fix at home");
  await report(phone, [[AWAY, 24.5]]);
  const list = await notifications(anna);
  assert.equal(list.length, 2);
  assert.equal(list[0].type, "left");
  assert.equal(list[0].data.at, Math.round(t0 + 24.5 * MIN));

  // Back home a quarter of an hour after the last arrival counts; leaving again within ten
  // minutes of the last departure does not.
  await report(phone, [[HOME, 26], [HOME, 28]]);
  await report(phone, [[AWAY, 29], [AWAY, 33]]);
  assert.deepEqual((await notifications(anna)).map((n) => n.type), ["arrived", "left", "arrived"]);

  assert.equal(await sentCount(fake, 3), 3);
  assert.deepEqual(fake.sent.map((m) => m.notification.title), ["luis arrived at Home", "luis left Home", "luis arrived at Home"]);
  assert.ok(fake.sent.every((m) => m.token === "anna-fcm"));
});

test("nobody hears about a hidden person, nor anyone who no longer shares a group", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const family = shareGroup("Family", luis.user, anna.user);
  const home = homeOf(luis);
  await call("PUT", "/api/alerts", { places: [home.id], recipients: { users: [anna.user.id], groups: [] } }, luis);
  const phone = await s.device("luis", "phone");
  await report(phone, [[AWAY, 0], [AWAY, 1]]);

  assert.equal((await call("PUT", "/api/me/hidden", { minutes: 60 }, luis)).status, 200);
  await report(phone, [[HOME, 10], [HOME, 12]]);
  assert.deepEqual(await notifications(anna), []);

  // The server kept track while the person was hidden: the next change is a departure.
  assert.equal((await call("DELETE", "/api/me/hidden", undefined, luis)).status, 200);
  await report(phone, [[AWAY, 30], [AWAY, 31]]);
  assert.deepEqual((await notifications(anna)).map((n) => n.type), ["left"]);

  removeMember(family.id, anna.user.id);
  await report(phone, [[HOME, 50], [HOME, 52]]);
  assert.deepEqual((await notifications(anna)).map((n) => n.type), ["left"]);
});

test("a group as recipient reaches every member, and the newest fix of a batch counts", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const tom = await s.account("tom");
  const family = shareGroup("Family", luis.user, anna.user, tom.user);
  const home = homeOf(luis);
  await call("PUT", "/api/alerts", { places: [home.id], recipients: { users: [], groups: [family.id] } }, luis);
  const phone = await s.device("luis", "phone");
  await report(phone, [[AWAY, 0], [AWAY, 1]]);

  const batch = async (fixes) => {
    phone.send({
      type: "positionBatch",
      points: fixes.map(([where, minute]) => ({ latitude: where.lat, longitude: where.lon, recordedAt: Math.round(t0 + minute * MIN) })),
    });
    await sync(phone);
  };
  // Only the newest fix of a batch counts: 12 starts the arrival, 15 completes it.
  await batch([[HOME, 10], [HOME, 12]]);
  assert.deepEqual(await notifications(anna), []);
  await batch([[HOME, 13], [HOME, 15]]);
  for (const who of [anna, tom]) assert.deepEqual((await notifications(who)).map((n) => n.type), ["arrived"]);
  assert.deepEqual(await notifications(luis), []);
});

test("a removed place stops counting", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  shareGroup("Family", luis.user, anna.user);
  const home = homeOf(luis);
  await call("PUT", "/api/alerts", { places: [home.id], recipients: { users: [anna.user.id], groups: [] } }, luis);
  assert.equal((await call("DELETE", `/api/places/${home.id}`, undefined, luis)).status, 204);
  assert.deepEqual((await (await call("GET", "/api/alerts", undefined, luis)).json()).places, []);
  const phone = await s.device("luis", "phone");
  await report(phone, [[AWAY, 0], [AWAY, 1], [HOME, 10], [HOME, 12]]);
  assert.deepEqual(await notifications(anna), []);
});

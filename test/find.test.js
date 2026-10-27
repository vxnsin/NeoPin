import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/db.js";
import { ACTIVE_MS, PENDING_MS, createFinder } from "../src/find.js";
import { shareGroup, startServer } from "./helpers.js";

let s;
let luis;
let anna;

beforeEach(async () => {
  s = await startServer();
  // The first account is the admin, the two below are ordinary people who share a group.
  await s.account("boss");
  luis = await s.account("luis");
  anna = await s.account("anna");
  shareGroup("Friends", luis.user, anna.user);
});

afterEach(() => s.stop());

// Opens a device of the account and swallows the device list it gets on login.
async function phone(username, deviceId) {
  const client = await s.device(username, deviceId);
  await client.next();
  return client;
}

// The next message of this type, device lists in between are skipped.
async function nextOf(client, type) {
  for (;;) {
    const msg = await client.next();
    if (msg.type === type) return msg;
  }
}

test("a find request reaches every phone of the asked person, the first answer decides", async () => {
  const asker = await phone("luis", "phone");
  const tablet = await phone("anna", "tablet");
  const target = await phone("anna", "phone");
  asker.send({ type: "findRequest", userId: anna.user.id });

  const pending = await nextOf(asker, "findPending");
  assert.equal(pending.peer.username, "anna");
  const askedOnPhone = await nextOf(target, "findRequest");
  const askedOnTablet = await nextOf(tablet, "findRequest");
  assert.equal(askedOnPhone.session, pending.session);
  assert.equal(askedOnTablet.session, pending.session);
  assert.equal(askedOnPhone.from.username, "luis");
  assert.ok(askedOnPhone.expiresAt > Date.now() && askedOnPhone.expiresAt <= Date.now() + PENDING_MS);

  target.send({ type: "findAnswer", session: pending.session, accept: true });
  const startedForAsker = await nextOf(asker, "findStarted");
  const startedForTarget = await nextOf(target, "findStarted");
  assert.equal(startedForAsker.peer.username, "anna");
  assert.equal(startedForTarget.peer.username, "luis");
  assert.ok(startedForAsker.expiresAt > Date.now() + PENDING_MS, "half an hour now");
  const dropped = await nextOf(tablet, "findEnded");
  assert.equal(dropped.reason, "answered");
});

test("positions go to the other side only and never into the history", async () => {
  const asker = await phone("luis", "phone");
  const target = await phone("anna", "phone");
  asker.send({ type: "findRequest", userId: anna.user.id });
  const { session } = await nextOf(asker, "findPending");
  await nextOf(target, "findRequest");
  target.send({ type: "findAnswer", session, accept: true });
  await nextOf(asker, "findStarted");
  await nextOf(target, "findStarted");

  asker.send({ type: "findPosition", session, latitude: 49.79, longitude: 9.95, accuracy: 6, heading: 90 });
  const seen = await nextOf(target, "findPosition");
  assert.equal(seen.latitude, 49.79);
  assert.equal(seen.heading, 90);
  assert.ok(seen.at <= Date.now());

  target.send({ type: "findPosition", session, latitude: 49.791, longitude: 9.951 });
  const back = await nextOf(asker, "findPosition");
  assert.equal(back.accuracy, null);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM positions").get().n, 0);
});

test("declining, ending and losing the connection tell the other side", async () => {
  const asker = await phone("luis", "phone");
  const target = await phone("anna", "phone");

  asker.send({ type: "findRequest", userId: anna.user.id });
  let { session } = await nextOf(asker, "findPending");
  await nextOf(target, "findRequest");
  target.send({ type: "findAnswer", session, accept: false });
  assert.equal((await nextOf(asker, "findEnded")).reason, "declined");

  asker.send({ type: "findRequest", userId: anna.user.id });
  ({ session } = await nextOf(asker, "findPending"));
  await nextOf(target, "findRequest");
  target.send({ type: "findAnswer", session, accept: true });
  await nextOf(asker, "findStarted");
  await nextOf(target, "findStarted");
  target.send({ type: "findEnd", session });
  assert.equal((await nextOf(asker, "findEnded")).reason, "ended");

  asker.send({ type: "findRequest", userId: anna.user.id });
  ({ session } = await nextOf(asker, "findPending"));
  await nextOf(target, "findRequest");
  target.send({ type: "findAnswer", session, accept: true });
  await nextOf(asker, "findStarted");
  await nextOf(target, "findStarted");
  asker.ws.close();
  assert.equal((await nextOf(target, "findEnded")).reason, "disconnected");
});

test("strangers, hidden people and people without a phone cannot be asked", async () => {
  const tom = await s.account("tom");
  const asker = await phone("luis", "phone");

  asker.send({ type: "findRequest", userId: tom.user.id });
  assert.equal((await nextOf(asker, "findEnded")).reason, "unavailable", "no shared group");

  asker.send({ type: "findRequest", userId: anna.user.id });
  assert.equal((await nextOf(asker, "findEnded")).reason, "offline", "anna has no phone online");

  const target = await phone("anna", "phone");
  getDb().prepare("UPDATE users SET hidden_until = ? WHERE id = ?").run(Date.now() + 60_000, anna.user.id);
  asker.send({ type: "findRequest", userId: anna.user.id });
  assert.equal((await nextOf(asker, "findEnded")).reason, "unavailable", "anna hides");
  assert.equal(target.ws.readyState, 1);
});

test("a stranger cannot answer or feed positions into someone else's session", async () => {
  await s.account("tom");
  const asker = await phone("luis", "phone");
  const target = await phone("anna", "phone");
  const intruder = await phone("tom", "phone");
  asker.send({ type: "findRequest", userId: anna.user.id });
  const { session } = await nextOf(asker, "findPending");
  await nextOf(target, "findRequest");

  intruder.send({ type: "findAnswer", session, accept: true });
  target.send({ type: "findAnswer", session, accept: true });
  const started = await nextOf(asker, "findStarted");
  assert.equal(started.peer.username, "anna", "tom's answer did nothing");

  intruder.send({ type: "findPosition", session, latitude: 1, longitude: 2 });
  target.send({ type: "findPosition", session, latitude: 3, longitude: 4 });
  const seen = await nextOf(asker, "findPosition");
  assert.equal(seen.latitude, 3, "only anna's position came through");
});

test("sessions run out on their own: two minutes unanswered, half an hour active", () => {
  let clock = 1_000_000;
  const ended = [];
  const finder = createFinder({ onEnd: (session, reason) => ended.push([session.id, reason]), now: () => clock });
  const pending = finder.request({ askerUserId: 1, askerDeviceId: "a", targetUserId: 2 });
  assert.equal(pending.expiresAt, clock + PENDING_MS);
  const active = finder.request({ askerUserId: 1, askerDeviceId: "a", targetUserId: 2 });
  assert.deepEqual(ended, [[pending.id, "replaced"]], "one search per device");
  clock += 1000;
  finder.answer(active.id, { userId: 2, deviceId: "b", accept: true });
  assert.equal(active.expiresAt, clock + ACTIVE_MS);
  assert.deepEqual(finder.peerOf(active, 1, "a"), { userId: 2, deviceId: "b" });
  assert.equal(finder.peerOf(active, 2, "c"), null, "another phone of anna is not in it");
  finder.reset();
});

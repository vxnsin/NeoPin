import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { ensureAdmin } from "../src/accounts.js";
import { getDb } from "../src/db.js";
import { PASSWORD, deviceHeaders, shareGroup, startServer } from "./helpers.js";

let s;

beforeEach(async () => {
  s = await startServer();
});

afterEach(() => s.stop());

test("a fresh database gets an admin with a generated password that must be changed", async () => {
  const created = ensureAdmin();
  assert.equal(created.username, "admin");
  assert.ok(created.password.length >= 16);
  assert.equal(ensureAdmin(), null, "only once");

  const cookie = await s.cookieFor("admin", created.password);
  const me = await (await fetch(`${s.baseUrl}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.isAdmin, true);
  assert.equal(me.mustChangePassword, true);
});

test("sign-up needs an invite code, see invites.test.js", async () => {
  assert.equal((await s.post("/api/register", { username: "luis", password: PASSWORD })).status, 400);
  assert.equal((await s.post("/api/register", { code: "AAAAA-AAAAA", username: "luis", password: PASSWORD })).status, 404);
  assert.deepEqual(await (await fetch(`${s.baseUrl}/api/status`)).json(), {
    version: config.version,
    commit: config.commit,
    builtAt: config.builtAt,
    push: false,
    invites: true,
  });
});

test("usernames and passwords are validated, names are unique regardless of case", async () => {
  const admin = await s.account("luis");
  const create = (body) => s.post("/api/users", body, { cookie: admin.cookie });
  assert.equal((await create({ username: "x", password: PASSWORD })).status, 400);
  assert.equal((await create({ username: "has space", password: PASSWORD })).status, 400);
  assert.equal((await create({ username: "anna", password: "short" })).status, 400);
  assert.equal((await create({ username: "anna", password: PASSWORD })).status, 201);
  assert.equal((await create({ username: "ANNA", password: PASSWORD })).status, 409);
});

test("changing the password needs the current one and ends the old logins", async () => {
  const luis = await s.account("luis");
  const change = (body, headers) => s.post("/api/me/password", body, headers);

  assert.equal((await change({ currentPassword: "wrong-password", newPassword: "a-new-password" }, { cookie: luis.cookie })).status, 401);
  assert.equal((await change({ currentPassword: PASSWORD, newPassword: "short" }, { cookie: luis.cookie })).status, 400);
  assert.equal((await change({ currentPassword: PASSWORD, newPassword: "a-new-password" })).status, 401, "not signed in");

  const phone = await s.device("luis", "phone", luis.token);
  await phone.next();
  const ok = await change({ currentPassword: PASSWORD, newPassword: "a-new-password" }, { cookie: luis.cookie });
  assert.equal(ok.status, 200);
  assert.equal((await phone.closed).code, 4000, "devices have to log in again");

  const viewer = await s.connect({ cookie: luis.cookie });
  viewer.send({ type: "authenticate", viewer: true });
  assert.deepEqual(await viewer.next(), { successful: true });

  assert.equal((await s.post("/login", { username: "luis", password: PASSWORD })).status, 401);
  assert.equal((await s.post("/login", { username: "luis", password: "a-new-password" })).status, 200);

  const fromDevice = await s.post("/api/auth/login", { username: "luis", password: "a-new-password", deviceId: "phone" });
  const { token } = await fromDevice.json();
  const again = await change({ currentPassword: "a-new-password", newPassword: "another-password" }, deviceHeaders("phone", token));
  assert.equal(again.status, 200);
  const fresh = (await again.json()).token;
  assert.equal((await fetch(`${s.baseUrl}/api/me`, { headers: deviceHeaders("phone", fresh) })).status, 200, "the asking device keeps working");
  assert.equal((await fetch(`${s.baseUrl}/api/me`, { headers: deviceHeaders("phone", token) })).status, 401);
});

test("passwords are stored hashed, never as they were typed", async () => {
  await s.account("luis");
  const row = getDb().prepare("SELECT password_hash FROM users").get();
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
});

test("the app login answers with a token that works as a bearer for that device", async () => {
  await s.account("luis");
  const bad = await s.post("/api/auth/login", { username: "luis", password: "wrong-password", deviceId: "phone" });
  assert.equal(bad.status, 401);

  const token = await s.tokenFor("luis", "phone");
  const me = await fetch(`${s.baseUrl}/api/me`, { headers: deviceHeaders("phone", token) });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).username, "luis");

  assert.equal((await fetch(`${s.baseUrl}/api/me`, { headers: deviceHeaders("tablet", token) })).status, 401);
  assert.equal((await fetch(`${s.baseUrl}/api/me`, { headers: deviceHeaders("phone", "wrong") })).status, 401);
});

test("logging in again on a device replaces its token, logout revokes it", async () => {
  await s.account("luis");
  const first = await s.tokenFor("luis", "phone");
  const second = await s.tokenFor("luis", "phone");
  assert.notEqual(first, second);
  assert.equal((await fetch(`${s.baseUrl}/api/me`, { headers: deviceHeaders("phone", first) })).status, 401);
  assert.equal((await fetch(`${s.baseUrl}/api/me`, { headers: deviceHeaders("phone", second) })).status, 200);

  const out = await fetch(`${s.baseUrl}/api/auth/logout`, { method: "POST", headers: deviceHeaders("phone", second) });
  assert.equal(out.status, 200);
  assert.equal((await fetch(`${s.baseUrl}/api/me`, { headers: deviceHeaders("phone", second) })).status, 401);
});

test("people in a shared group see each other's devices, with their owner", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const tom = await s.account("tom");
  shareGroup("Family", luis.user, anna.user); // tom is in no group with them

  const luisPhone = await s.device("luis", "phone", luis.token);
  await luisPhone.next();
  const annaPhone = await s.device("anna", "phone", anna.token);
  await annaPhone.next();
  const tomPhone = await s.device("tom", "phone", tom.token);
  await tomPhone.next();

  const list = async (cookie) => (await fetch(`${s.baseUrl}/api/getData`, { headers: { cookie } })).json();

  const seenByAnna = await list(anna.cookie);
  assert.deepEqual(seenByAnna.map((d) => d.owner.username).sort(), ["anna", "luis"]);
  assert.deepEqual((await list(tom.cookie)).map((d) => d.owner.username), ["tom"], "tom sees only himself");

  luisPhone.send({ type: "updatePosition", latitude: 10, longitude: 20 });
  await luisPhone.next();
  const after = await list(anna.cookie);
  assert.deepEqual(after.find((d) => d.owner.username === "luis").position, { latitude: 10, longitude: 20 });
  assert.equal(after.find((d) => d.owner.username === "anna").position, null, "the same device name under two accounts stays two devices");
  assert.equal(after[0].groupIds.length, 1);

  const annaUserId = seenByAnna.find((d) => d.owner.username === "anna").userId;
  assert.equal((await s.post("/api/sendPing", { deviceId: "phone", userId: annaUserId }, { cookie: luis.cookie })).status, 200);
  const tomUserId = (await list(tom.cookie))[0].userId;
  assert.equal((await s.post("/api/sendPing", { deviceId: "phone", userId: tomUserId }, { cookie: anna.cookie })).status, 404, "tom is out of reach for anna");
  assert.equal((await s.post("/api/sendPing", { deviceId: "phone", userId: tomUserId }, { cookie: luis.cookie })).status, 200, "the admin reaches everyone");
});

test("the admin creates and removes accounts from the dashboard, others cannot", async () => {
  const luis = await s.account("luis");
  const create = (body, cookie = luis.cookie) => s.post("/api/users", body, { cookie });

  const made = await create({ username: "anna", password: PASSWORD, displayName: "Anna" });
  assert.equal(made.status, 201);
  const anna = await made.json();
  assert.equal(anna.isAdmin, false);
  assert.equal((await create({ username: "anna", password: PASSWORD })).status, 409);
  assert.equal((await create({ username: "bo", password: PASSWORD })).status, 400);

  const annaCookie = await s.cookieFor("anna");
  assert.equal((await create({ username: "tom", password: PASSWORD }, annaCookie)).status, 403);
  assert.equal((await fetch(`${s.baseUrl}/api/users`, { headers: { cookie: annaCookie } })).status, 403);

  const users = await (await fetch(`${s.baseUrl}/api/users`, { headers: { cookie: luis.cookie } })).json();
  assert.deepEqual(users.map((u) => [u.username, u.isAdmin]), [["luis", true], ["anna", false]]);

  const self = await fetch(`${s.baseUrl}/api/users/${luis.user.id}`, { method: "DELETE", headers: { cookie: luis.cookie } });
  assert.equal(self.status, 400);
  const removed = await fetch(`${s.baseUrl}/api/users/${anna.id}`, { method: "DELETE", headers: { cookie: luis.cookie } });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(`${s.baseUrl}/api/me`, { headers: { cookie: annaCookie } })).status, 401);
  assert.equal((await s.post("/login", { username: "anna", password: PASSWORD })).status, 401);
});

test("linked devices are listed with their state and can be unlinked", async () => {
  const luis = await s.account("luis");
  const phone = await s.device("luis", "phone", luis.token);
  await phone.next();
  await s.tokenFor("luis", "tablet");

  const list = async () => (await fetch(`${s.baseUrl}/api/devices`, { headers: { cookie: luis.cookie } })).json();
  const linked = await list();
  assert.deepEqual(linked.map((d) => [d.deviceId, d.status]), [["phone", "online"], ["tablet", "offline"]]);
  assert.ok(linked[0].linkedAt);

  const gone = await fetch(`${s.baseUrl}/api/devices/phone`, { method: "DELETE", headers: { cookie: luis.cookie } });
  assert.equal(gone.status, 204);
  assert.equal((await phone.closed).code, 4000);
  assert.deepEqual((await list()).map((d) => d.deviceId), ["tablet"]);
  assert.equal((await fetch(`${s.baseUrl}/api/me`, { headers: deviceHeaders("phone", luis.token) })).status, 401);
  assert.equal((await fetch(`${s.baseUrl}/api/devices/ghost`, { method: "DELETE", headers: { cookie: luis.cookie } })).status, 404);
});

test("the device type is stored at login and shown for live and offline devices", async () => {
  const luis = await s.account("luis");
  const login = (deviceId, deviceType) =>
    s.post("/api/auth/login", { username: "luis", password: PASSWORD, deviceId, deviceType });
  const pad = await login("pad", "tablet");
  assert.equal(pad.status, 200);
  assert.equal((await login("bad", "toaster")).status, 400);
  await s.tokenFor("luis", "plain");

  const list = await (await fetch(`${s.baseUrl}/api/devices`, { headers: { cookie: luis.cookie } })).json();
  assert.deepEqual(list.map((d) => [d.deviceId, d.deviceType]), [["phone", "phone"], ["pad", "tablet"], ["plain", "phone"]]);

  const token = (await (await login("mac", "desktop")).json()).token;
  const mac = await s.connect();
  mac.send({ type: "authenticate", deviceId: "mac", token, deviceType: "desktop" });
  await mac.next();
  const devices = await (await fetch(`${s.baseUrl}/api/getData`, { headers: { cookie: luis.cookie } })).json();
  assert.equal(devices.find((d) => d.deviceId === "mac").deviceType, "desktop");
});

test("only the admin may open the timeline and devices of another account", async () => {
  const luis = await s.account("luis"); // the first account is the admin
  const anna = await s.account("anna");
  const { recordPosition } = await import("../src/history.js");
  recordPosition(anna.user.id, "phone", 48.1, 11.5, Date.UTC(2025, 5, 10, 9));
  await s.tokenFor("anna", "phone");

  const q = (userId) => `${s.baseUrl}/api/timeline?deviceId=phone&date=2025-06-10&userId=${userId}`;
  const asAdmin = await fetch(q(anna.user.id), { headers: { cookie: luis.cookie } });
  assert.equal(asAdmin.status, 200);
  assert.equal((await asAdmin.json()).summary.pointCount, 1);
  assert.equal((await fetch(q(999), { headers: { cookie: luis.cookie } })).status, 404);

  assert.equal((await fetch(q(anna.user.id), { headers: { cookie: anna.cookie } })).status, 200, "own id is fine");
  const denied = await fetch(q(luis.user.id), { headers: { cookie: anna.cookie } });
  assert.equal(denied.status, 403, "another account's timeline is closed to normal users");

  const days = await fetch(`${s.baseUrl}/api/timeline/days?deviceId=phone&userId=${anna.user.id}`, { headers: { cookie: luis.cookie } });
  assert.deepEqual(await days.json(), ["2025-06-10"]);
  assert.equal((await fetch(`${s.baseUrl}/api/timeline/days?deviceId=phone&userId=${luis.user.id}`, { headers: { cookie: anna.cookie } })).status, 403);

  const devices = await fetch(`${s.baseUrl}/api/users/${anna.user.id}/devices`, { headers: { cookie: luis.cookie } });
  assert.deepEqual((await devices.json()).map((d) => d.deviceId), ["phone"]);
  assert.equal((await fetch(`${s.baseUrl}/api/users/${luis.user.id}/devices`, { headers: { cookie: anna.cookie } })).status, 403);
});

test("everyone edits their own name and username, the admin edits anyone", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const patch = (route, body, cookie) =>
    fetch(`${s.baseUrl}${route}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  const own = await patch("/api/me", { displayName: "Anna B.", username: "anna_b" }, anna.cookie);
  assert.equal(own.status, 200);
  assert.deepEqual([(await own.json()).displayName, (await (await fetch(`${s.baseUrl}/api/me`, { headers: { cookie: anna.cookie } })).json()).username], ["Anna B.", "anna_b"]);

  assert.equal((await patch("/api/me", { username: "luis" }, anna.cookie)).status, 409);
  assert.equal((await patch("/api/me", { username: "x" }, anna.cookie)).status, 400);
  assert.equal((await patch("/api/me", { displayName: "  " }, anna.cookie)).status, 400);
  assert.equal((await patch("/api/me", { displayName: "Nobody" }, undefined)).status, 401);

  assert.equal((await patch(`/api/users/${luis.user.id}`, { displayName: "Boss" }, anna.cookie)).status, 403);
  const edited = await patch(`/api/users/${anna.user.id}`, { displayName: "Anna K.", password: "a-reset-password" }, luis.cookie);
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).displayName, "Anna K.");
  assert.equal((await s.post("/login", { username: "anna_b", password: "a-reset-password" })).status, 200);
  assert.equal((await patch(`/api/users/999`, { displayName: "X" }, luis.cookie)).status, 404);
  assert.equal((await patch(`/api/users/${anna.user.id}`, { password: "short" }, luis.cookie)).status, 400);
});

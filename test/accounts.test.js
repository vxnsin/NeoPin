import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { ensureAdmin } from "../src/accounts.js";
import { getDb } from "../src/db.js";
import { PASSWORD, deviceHeaders, startServer } from "./helpers.js";

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

test("there is no self-service sign-up", async () => {
  assert.equal((await s.post("/api/register", { username: "luis", password: PASSWORD })).status, 404);
  assert.deepEqual(await (await fetch(`${s.baseUrl}/api/status`)).json(), { version: config.version });
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

test("every account sees only its own devices", async () => {
  await s.account("luis");
  await s.account("anna");

  const luisPhone = await s.device("luis", "phone");
  await luisPhone.next();
  const annaPhone = await s.device("anna", "phone");
  await annaPhone.next();

  const luisCookie = await s.cookieFor("luis");
  const annaCookie = await s.cookieFor("anna");
  const list = async (cookie) => (await fetch(`${s.baseUrl}/api/getData`, { headers: { cookie } })).json();

  assert.equal((await list(luisCookie)).length, 1);
  assert.equal((await list(annaCookie)).length, 1);

  luisPhone.send({ type: "updatePosition", latitude: 10, longitude: 20 });
  await luisPhone.next();
  assert.deepEqual((await list(luisCookie))[0].position, { latitude: 10, longitude: 20 });
  assert.equal((await list(annaCookie))[0].position, null, "the same device name of another account stays separate");

  assert.equal((await s.post("/api/sendPing", { deviceId: "phone" }, { cookie: annaCookie })).status, 200);
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

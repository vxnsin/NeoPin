import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { PASSWORD, deviceHeaders, startServer } from "./helpers.js";

let s;

beforeEach(async () => {
  s = await startServer();
  config.allowRegistration = false;
});

afterEach(() => s.stop());

test("the first account can always be registered, more only when allowed", async () => {
  assert.equal((await (await fetch(`${s.baseUrl}/api/status`)).json()).registrationOpen, true);

  const first = await s.post("/api/register", { username: "luis", password: PASSWORD, displayName: "Luis" });
  assert.equal(first.status, 201);
  const user = await first.json();
  assert.equal(user.username, "luis");
  assert.equal(user.displayName, "Luis");
  assert.equal(user.avatarUrl, null);

  assert.equal((await (await fetch(`${s.baseUrl}/api/status`)).json()).registrationOpen, false);
  assert.equal((await s.post("/api/register", { username: "anna", password: PASSWORD })).status, 403);

  config.allowRegistration = true;
  assert.equal((await s.post("/api/register", { username: "anna", password: PASSWORD })).status, 201);
});

test("usernames and passwords are validated, names are unique regardless of case", async () => {
  assert.equal((await s.post("/api/register", { username: "x", password: PASSWORD })).status, 400);
  assert.equal((await s.post("/api/register", { username: "has space", password: PASSWORD })).status, 400);
  assert.equal((await s.post("/api/register", { username: "luis", password: "short" })).status, 400);

  assert.equal((await s.post("/api/register", { username: "luis", password: PASSWORD })).status, 201);
  config.allowRegistration = true;
  assert.equal((await s.post("/api/register", { username: "LUIS", password: PASSWORD })).status, 409);
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
  config.allowRegistration = true;
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

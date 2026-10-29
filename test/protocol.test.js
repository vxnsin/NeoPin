import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { destroyAllSessions } from "../src/sessions.js";
import { PASSWORD, startServer } from "./helpers.js";

let s;

beforeEach(async () => {
  s = await startServer();
  await s.account("luis");
});

afterEach(() => s.stop());

test("a device authenticates with its token and receives the device list", async () => {
  const phone = await s.device("luis", "phone");
  assert.deepEqual(phone.reply, { successful: true, features: ["positionBatch", "find", "rideQuestion"] });
  const list = await phone.next();
  assert.equal(list.type, "dataResponse");
  assert.equal(list.devices[0].deviceId, "phone");
  assert.equal(list.devices[0].status, "online");
});

test("a wrong token closes the connection with code 4000", async () => {
  const intruder = await s.connect();
  intruder.send({ type: "authenticate", deviceId: "phone", token: "nope" });
  const { code, reason } = await intruder.closed;
  assert.equal(code, 4000);
  assert.equal(reason, "Unauthorized");
});

test("a token only works for the device it was issued to", async () => {
  const token = await s.tokenFor("luis", "phone");
  const other = await s.connect();
  other.send({ type: "authenticate", deviceId: "tablet", token });
  assert.equal((await other.closed).code, 4000);
});

test("repeated wrong tokens lock the address out for a while", async () => {
  for (let i = 0; i < config.deviceAuthLimit.max; i++) {
    const intruder = await s.connect();
    intruder.send({ type: "authenticate", deviceId: "phone", token: "wrong" });
    await intruder.closed;
  }
  const token = await s.tokenFor("luis", "phone");
  const locked = await s.connect();
  locked.send({ type: "authenticate", deviceId: "phone", token });
  const { code, reason } = await locked.closed;
  assert.equal(code, 4000);
  assert.equal(reason, "Too many attempts");
});

test("a message outside the protocol closes the socket", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  phone.send({ type: "updatePosition", latitude: 500, longitude: 11 });
  assert.equal((await phone.closed).code, 1007);
});

test("position updates reach the other devices of the same account", async () => {
  const a = await s.device("luis", "a");
  await a.next();
  const b = await s.device("luis", "b");
  await b.next();
  await a.next(); // broadcast caused by b joining

  b.send({ type: "updatePosition", latitude: 48.1, longitude: 11.5 });
  const update = await a.next();
  assert.equal(update.type, "dataResponse");
  const deviceB = update.devices.find((d) => d.deviceId === "b");
  assert.deepEqual(deviceB.position, { latitude: 48.1, longitude: 11.5 });
  assert.ok(deviceB.lastPing);
});

test("a reconnecting device replaces its old socket instead of being rejected", async () => {
  const first = await s.device("luis", "phone");
  await first.next();
  const second = await s.device("luis", "phone");
  assert.equal(second.reply.successful, true);
  assert.equal((await first.closed).code, 4001);
  const list = await second.next();
  assert.equal(list.devices.filter((d) => d.deviceId === "phone").length, 1);
  assert.equal(list.devices[0].status, "online");
});

test("pingDevices asks the other devices for a location and answers with the list", async () => {
  const asker = await s.device("luis", "asker");
  await asker.next();
  const target = await s.device("luis", "target");
  await target.next();
  await asker.next();

  asker.send({ type: "pingDevices" });
  const request = await target.next();
  assert.equal(request.type, "requestLocation");
  assert.equal(request.from, "asker");
  target.send({ type: "updatePosition", latitude: 1, longitude: 2 });

  let reply = await asker.next();
  while (!reply.devices.find((d) => d.deviceId === "target")?.position) reply = await asker.next();
  assert.deepEqual(reply.devices.find((d) => d.deviceId === "target").position, { latitude: 1, longitude: 2 });
});

test("dashboard login issues a session cookie and rejects wrong passwords", async () => {
  assert.equal((await s.post("/login", { username: "luis", password: "wrong-password" })).status, 401);
  assert.equal((await s.post("/login", { username: "nobody", password: PASSWORD })).status, 401);

  const good = await s.post("/login", { username: "luis", password: PASSWORD });
  assert.equal(good.status, 200);
  const cookie = good.headers.get("set-cookie");
  assert.match(cookie, /neopin_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.doesNotMatch(cookie, new RegExp(PASSWORD));

  const data = await fetch(`${s.baseUrl}/api/getData`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(data.status, 200);
  const listed = await data.json();
  assert.deepEqual(listed.map((d) => [d.deviceId, d.status]), [["phone", "offline"]], "the linked device shows before it connects");

  assert.equal((await fetch(`${s.baseUrl}/api/getData`)).status, 401);
});

test("the dashboard page needs a session, the login page does not", async () => {
  const anonymous = await fetch(`${s.baseUrl}/`, { redirect: "manual" });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get("location"), "/login");

  const loginPage = await fetch(`${s.baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  const oldLink = await fetch(`${s.baseUrl}/login.html`, { redirect: "manual" });
  assert.equal(oldLink.headers.get("location"), "/login");
  assert.match(loginPage.headers.get("content-security-policy"), /script-src 'self'/);

  const cookie = await s.cookieFor("luis");
  const dashboard = await fetch(`${s.baseUrl}/`, { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /<div id="map">/);
});

test("the login endpoint is rate limited, the rest of the app is not", async () => {
  let last;
  for (let i = 0; i < config.loginRateLimit.max + 1; i++) last = await s.post("/login", { username: "luis", password: "wrong-password" });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get("retry-after"));
  assert.equal((await fetch(`${s.baseUrl}/login`)).status, 200);
});

test("logout and sessions-clear end dashboard sessions", async () => {
  const cookie = await s.cookieFor("luis");
  await fetch(`${s.baseUrl}/logout`, { headers: { cookie }, redirect: "manual" });
  assert.equal((await fetch(`${s.baseUrl}/api/getData`, { headers: { cookie } })).status, 401);

  const other = await s.cookieFor("luis");
  destroyAllSessions();
  assert.equal((await fetch(`${s.baseUrl}/api/getData`, { headers: { cookie: other } })).status, 401);
});

test("a dashboard viewer needs a valid session and then receives live data", async () => {
  const rejected = await s.connect();
  rejected.send({ type: "authenticate", viewer: true });
  assert.equal((await rejected.closed).code, 4000);

  const cookie = await s.cookieFor("luis");
  const viewer = await s.connect({ cookie });
  viewer.send({ type: "authenticate", viewer: true });
  assert.deepEqual(await viewer.next(), { successful: true });
  assert.equal((await viewer.next()).type, "dataResponse");

  const phone = await s.device("luis", "phone");
  await phone.next();
  const live = await viewer.next();
  assert.equal(live.devices[0].deviceId, "phone");
});

test("a viewer cookie sent from a foreign page is refused", async () => {
  const cookie = await s.cookieFor("luis");
  const viewer = await s.connect({ cookie, origin: "https://evil.example" });
  viewer.send({ type: "authenticate", viewer: true });
  assert.equal((await viewer.closed).code, 4000);
});

test("sendPing over HTTP asks a device and answers with the list", async () => {
  const cookie = await s.cookieFor("luis");
  const ping = (body) => s.post("/api/sendPing", body, { cookie });
  assert.equal((await ping({})).status, 202);

  const phone = await s.device("luis", "phone");
  await phone.next();
  assert.equal((await ping({ deviceId: "ghost" })).status, 404);

  const asked = ping({ deviceId: "phone" });
  let request = await phone.next();
  while (request.type !== "requestLocation") request = await phone.next();
  phone.send({ type: "updatePosition", latitude: 3, longitude: 4 });
  const res = await asked;
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).devices[0].position, { latitude: 3, longitude: 4 });
});

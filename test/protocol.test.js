import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { resetDevices } from "../src/devices.js";
import { destroyAllSessions } from "../src/sessions.js";

config.password = "test-secret";
config.locationWaitMs = 100;

let server;
let http;
let baseUrl;
let wsUrl;
let openSockets = [];

// A fresh app per test, so rate limits and failed logins start at zero.
beforeEach(async () => {
  resetDevices();
  server = createApp({ gracefulShutdown: false });
  http = await server.app.listen(0, "127.0.0.1");
  const { port } = http.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const ws of openSockets.splice(0)) ws.close();
  server.stop();
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
});

function connect(headers) {
  const ws = new WebSocket(wsUrl, headers ? { headers } : undefined);
  openSockets.push(ws);
  const queue = [];
  const waiters = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const waiter = waiters.shift();
    waiter ? waiter(msg) : queue.push(msg);
  });
  const next = () =>
    new Promise((resolve) => (queue.length ? resolve(queue.shift()) : waiters.push(resolve)));
  const send = (msg) => ws.send(JSON.stringify(msg));
  const closed = new Promise((resolve) =>
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }))
  );
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, next, send, closed }), { once: true });
    ws.addEventListener("error", () => reject(new Error("did not open")), { once: true });
  });
}

async function connectDevice(deviceId, password = config.password) {
  const client = await connect();
  client.send({ type: "authenticate", deviceId, password });
  const reply = await client.next();
  return { ...client, reply };
}

const login = (password) =>
  fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });

async function sessionCookie() {
  const res = await login(config.password);
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}

test("a device authenticates and receives the device list", async () => {
  const phone = await connectDevice("phone");
  assert.deepEqual(phone.reply, { successful: true });
  const list = await phone.next();
  assert.equal(list.type, "dataResponse");
  assert.equal(list.devices[0].deviceId, "phone");
  assert.equal(list.devices[0].status, "online");
});

test("a wrong password closes the connection with code 4000", async () => {
  const intruder = await connect();
  intruder.send({ type: "authenticate", deviceId: "phone", password: "wrong" });
  const { code, reason } = await intruder.closed;
  assert.equal(code, 4000);
  assert.equal(reason, "Unauthorized");
});

test("repeated wrong passwords lock the address out for a while", async () => {
  for (let i = 0; i < config.deviceAuthLimit.max; i++) {
    const intruder = await connect();
    intruder.send({ type: "authenticate", deviceId: "phone", password: "wrong" });
    await intruder.closed;
  }
  const locked = await connect();
  locked.send({ type: "authenticate", deviceId: "phone", password: config.password });
  const { code, reason } = await locked.closed;
  assert.equal(code, 4000);
  assert.equal(reason, "Too many attempts");
});

test("a message outside the protocol closes the socket", async () => {
  const phone = await connectDevice("phone");
  await phone.next();
  phone.send({ type: "updatePosition", latitude: 500, longitude: 11 });
  const { code } = await phone.closed;
  assert.equal(code, 1007);
});

test("position updates are broadcast to other devices", async () => {
  const a = await connectDevice("a");
  await a.next();
  const b = await connectDevice("b");
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
  const first = await connectDevice("phone");
  await first.next();
  const second = await connectDevice("phone");
  assert.deepEqual(second.reply, { successful: true });
  const { code } = await first.closed;
  assert.equal(code, 4001, "old socket is closed as replaced");
  const list = await second.next();
  assert.equal(list.devices.filter((d) => d.deviceId === "phone").length, 1);
  assert.equal(list.devices[0].status, "online");
});

test("pingDevices asks the other devices for a location and answers with the list", async () => {
  const asker = await connectDevice("asker");
  await asker.next();
  const target = await connectDevice("target");
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
  const bad = await login("wrong");
  assert.equal(bad.status, 401);

  const good = await login(config.password);
  assert.equal(good.status, 200);
  const cookie = good.headers.get("set-cookie");
  assert.match(cookie, /neopin_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.doesNotMatch(cookie, new RegExp(config.password));

  const data = await fetch(`${baseUrl}/api/getData`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(data.status, 200);
  assert.deepEqual(await data.json(), []);

  const anonymous = await fetch(`${baseUrl}/api/getData`);
  assert.equal(anonymous.status, 401);
});

test("the dashboard page needs a session, the login page does not", async () => {
  const anonymous = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get("location"), "/login");

  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.headers.get("content-security-policy"), /script-src 'self'/);

  const cookie = await sessionCookie();
  const dashboard = await fetch(`${baseUrl}/`, { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /<div id="map">/);
});

test("the login endpoint is rate limited, the rest of the app is not", async () => {
  let last;
  for (let i = 0; i < config.loginRateLimit.max + 1; i++) last = await login("wrong");
  assert.equal(last.status, 429);
  assert.ok(last.headers.get("retry-after"));

  const page = await fetch(`${baseUrl}/login`);
  assert.equal(page.status, 200);
});

test("logout and sessions-clear end dashboard sessions", async () => {
  const cookie = await sessionCookie();
  await fetch(`${baseUrl}/logout`, { headers: { cookie }, redirect: "manual" });
  assert.equal((await fetch(`${baseUrl}/api/getData`, { headers: { cookie } })).status, 401);

  const other = await sessionCookie();
  destroyAllSessions();
  assert.equal((await fetch(`${baseUrl}/api/getData`, { headers: { cookie: other } })).status, 401);
});

test("a dashboard viewer needs a valid session and then receives live data", async () => {
  const rejected = await connect();
  rejected.send({ type: "authenticate", viewer: true });
  assert.equal((await rejected.closed).code, 4000);

  const cookie = await sessionCookie();
  const viewer = await connect({ cookie });
  viewer.send({ type: "authenticate", viewer: true });
  assert.deepEqual(await viewer.next(), { successful: true });
  assert.equal((await viewer.next()).type, "dataResponse");

  const phone = await connectDevice("phone");
  await phone.next();
  const live = await viewer.next();
  assert.equal(live.devices[0].deviceId, "phone");
});

test("a viewer cookie sent from a foreign page is refused", async () => {
  const cookie = await sessionCookie();
  const viewer = await connect({ cookie, origin: "https://evil.example" });
  viewer.send({ type: "authenticate", viewer: true });
  assert.equal((await viewer.closed).code, 4000);
});

test("sendPing over HTTP asks a device and answers with the list", async () => {
  const cookie = await sessionCookie();
  const none = await fetch(`${baseUrl}/api/sendPing`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(none.status, 202);

  const phone = await connectDevice("phone");
  await phone.next();
  const missing = await fetch(`${baseUrl}/api/sendPing`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "ghost" }),
  });
  assert.equal(missing.status, 404);

  const asked = fetch(`${baseUrl}/api/sendPing`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "phone" }),
  });
  let request = await phone.next();
  while (request.type !== "requestLocation") request = await phone.next();
  phone.send({ type: "updatePosition", latitude: 3, longitude: 4 });
  const res = await asked;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.devices[0].position, { latitude: 3, longitude: 4 });
});

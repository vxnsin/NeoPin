import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { config } from "../src/config.js";
import { createApp } from "../src/http.js";
import { createSocketServer } from "../src/ws.js";
import { resetDevices } from "../src/devices.js";
import { destroyAllSessions } from "../src/sessions.js";

let server;
let sockets;
let app;
let baseUrl;
let wsUrl;
const openSockets = [];

before(async () => {
  config.password = "test-secret";
  config.locationWaitMs = 100;
  const pending = {};
  app = createApp({
    requestLocation: (...args) => pending.sockets.requestLocation(...args),
    broadcastDevices: () => pending.sockets.broadcastDevices(),
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  sockets = pending.sockets = createSocketServer(server);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
});

after(async () => {
  for (const ws of openSockets) ws.terminate();
  sockets.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  for (const ws of openSockets.splice(0)) ws.terminate();
  resetDevices();
  destroyAllSessions();
  app.locals.loginLimiter.reset();
});

function connect(headers) {
  const ws = new WebSocket(wsUrl, { headers });
  openSockets.push(ws);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    waiter ? waiter(msg) : queue.push(msg);
  });
  const next = () =>
    new Promise((resolve) => (queue.length ? resolve(queue.shift()) : waiters.push(resolve)));
  const send = (msg) => ws.send(JSON.stringify(msg));
  const closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  return new Promise((resolve) => ws.on("open", () => resolve({ ws, next, send, closed })));
}

async function connectDevice(deviceId, password = config.password) {
  const client = await connect();
  client.send({ type: "authenticate", deviceId, password });
  const reply = await client.next();
  return { ...client, reply };
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
  assert.equal(code, 1006, "old socket is terminated");
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
  const bad = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(bad.status, 401);

  const good = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: config.password }),
  });
  assert.equal(good.status, 200);
  const cookie = good.headers.get("set-cookie");
  assert.match(cookie, /neopin_session=[a-f0-9]{64}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, new RegExp(config.password));

  const data = await fetch(`${baseUrl}/api/getData`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(data.status, 200);
  assert.deepEqual(await data.json(), []);

  const anonymous = await fetch(`${baseUrl}/api/getData`);
  assert.equal(anonymous.status, 401);
});

test("the login endpoint is rate limited", async () => {
  const attempt = () =>
    fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
  let last;
  for (let i = 0; i < config.loginRateLimit.max + 1; i++) last = await attempt();
  assert.equal(last.status, 429);
});

test("a dashboard viewer needs a valid session and then receives live data", async () => {
  const rejected = await connect();
  rejected.send({ type: "authenticate", viewer: true });
  assert.equal((await rejected.closed).code, 4000);

  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: config.password }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const viewer = await connect({ cookie });
  viewer.send({ type: "authenticate", viewer: true });
  assert.deepEqual(await viewer.next(), { successful: true });
  assert.equal((await viewer.next()).type, "dataResponse");

  const phone = await connectDevice("phone");
  await phone.next();
  const live = await viewer.next();
  assert.equal(live.devices[0].deviceId, "phone");
});

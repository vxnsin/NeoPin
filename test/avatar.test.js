import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { resetDevices } from "../src/devices.js";

config.password = "test-secret";

let server;
let http;
let baseUrl;
let wsUrl;
let openSockets = [];

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

// A JPEG as far as the server looks: the start-of-image marker and some bytes.
const jpeg = (fill = 1, size = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill)]);

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
  const next = () => new Promise((resolve) => (queue.length ? resolve(queue.shift()) : waiters.push(resolve)));
  const send = (msg) => ws.send(JSON.stringify(msg));
  return new Promise((resolve) => ws.addEventListener("open", () => resolve({ next, send }), { once: true }));
}

async function connectDevice(deviceId) {
  const client = await connect();
  client.send({ type: "authenticate", deviceId, password: config.password });
  assert.deepEqual(await client.next(), { successful: true });
  await client.next(); // the list sent after joining
  return client;
}

// The app percent-encodes both values, header values have to stay ASCII.
const deviceHeaders = (deviceId, password = config.password) => ({
  "x-device-id": encodeURIComponent(deviceId),
  authorization: `Bearer ${encodeURIComponent(password)}`,
});

const upload = (body, { deviceId = "phone", password, type = "image/jpeg", headers } = {}) =>
  fetch(`${baseUrl}/api/avatar`, {
    method: "PUT",
    headers: { ...(headers ?? deviceHeaders(deviceId, password)), "content-type": type },
    body,
  });

async function sessionCookie() {
  const res = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: config.password }),
  });
  return res.headers.get("set-cookie").split(";")[0];
}

test("a device uploads its picture and everyone gets the new avatarUrl", async () => {
  const phone = await connectDevice("phone");

  const res = await upload(jpeg());
  assert.equal(res.status, 200);
  const { avatarUrl } = await res.json();
  assert.match(avatarUrl, /^\/avatars\/phone\?v=[\w-]{12}$/);

  const update = await phone.next();
  assert.equal(update.type, "dataResponse");
  assert.equal(update.devices[0].avatarUrl, avatarUrl);
});

test("the picture is served to dashboards and devices, not to anyone else", async () => {
  await connectDevice("phone");
  const picture = jpeg(7);
  const { avatarUrl } = await (await upload(picture)).json();

  const cookie = await sessionCookie();
  const forDashboard = await fetch(baseUrl + avatarUrl, { headers: { cookie } });
  assert.equal(forDashboard.status, 200);
  assert.equal(forDashboard.headers.get("content-type"), "image/jpeg");
  assert.match(forDashboard.headers.get("cache-control"), /immutable/);
  assert.deepEqual(Buffer.from(await forDashboard.arrayBuffer()), picture);

  const forDevice = await fetch(baseUrl + avatarUrl, { headers: deviceHeaders("phone") });
  assert.equal(forDevice.status, 200);

  assert.equal((await fetch(baseUrl + avatarUrl)).status, 401);
  assert.equal((await fetch(`${baseUrl}/avatars/ghost`, { headers: { cookie } })).status, 404);
});

test("an upload needs the server password and a device that has connected", async () => {
  await connectDevice("phone");

  assert.equal((await upload(jpeg(), { password: "wrong" })).status, 401);
  assert.equal((await upload(jpeg(), { headers: {} })).status, 401);
  assert.equal((await upload(jpeg(), { headers: { authorization: `Bearer ${config.password}` } })).status, 401);
  assert.equal((await upload(jpeg(), { deviceId: "ghost" })).status, 404);

  const cookie = await sessionCookie();
  const dashboardOnly = await upload(jpeg(), { headers: { cookie } });
  assert.equal(dashboardOnly.status, 401, "a dashboard session cannot set a device's picture");
});

test("wrong passwords on the upload count against the same limit as socket logins", async () => {
  await connectDevice("phone");
  for (let i = 0; i < config.deviceAuthLimit.max; i++) {
    assert.equal((await upload(jpeg(), { password: "wrong" })).status, 401);
  }
  assert.equal((await upload(jpeg())).status, 429);
});

test("device names outside ASCII work once percent-encoded", async () => {
  await connectDevice("Luis’ iPhone");
  const res = await upload(jpeg(), { deviceId: "Luis’ iPhone" });
  assert.equal(res.status, 200);
  const { avatarUrl } = await res.json();
  assert.equal(avatarUrl.split("?")[0], `/avatars/${encodeURIComponent("Luis’ iPhone")}`);
  assert.equal((await fetch(baseUrl + avatarUrl, { headers: deviceHeaders("Luis’ iPhone") })).status, 200);
});

test("only small pictures of a known type are taken", async () => {
  await connectDevice("phone");

  assert.equal((await upload("hello", { type: "text/plain" })).status, 415);
  assert.equal((await upload(jpeg(1, 17 * 1024))).status, 413);
  assert.equal((await upload(Buffer.from("<svg onload=alert(1)>"), { type: "image/jpeg" })).status, 400);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  assert.equal((await upload(png, { type: "image/png" })).status, 200);
  assert.equal((await upload(png, { type: "image/jpeg" })).status, 400, "type and bytes must agree");
});

test("a new picture gets a new URL and deleting it clears avatarUrl", async () => {
  await connectDevice("phone");
  const first = (await (await upload(jpeg(1))).json()).avatarUrl;
  const second = (await (await upload(jpeg(2))).json()).avatarUrl;
  assert.notEqual(first, second);

  const removed = await fetch(`${baseUrl}/api/avatar`, { method: "DELETE", headers: deviceHeaders("phone") });
  assert.equal(removed.status, 204);

  const cookie = await sessionCookie();
  const devices = await (await fetch(`${baseUrl}/api/getData`, { headers: { cookie } })).json();
  assert.equal(devices[0].avatarUrl, null);
  assert.equal((await fetch(baseUrl + second, { headers: { cookie } })).status, 404);
});

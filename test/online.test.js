import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { startServer } from "./helpers.js";

// Short times, so a grace of two report periods passes within the test.
config.onlineGrace = { minMs: 0, slackMs: 300, defaultIntervalMs: 60_000 };
config.statusSweepMs = 100;

let s;

beforeEach(async () => {
  s = await startServer();
  await s.account("luis");
});

afterEach(() => s.stop());

// Waits for a device list in which the device has the given status.
async function until(client, deviceId, status) {
  for (;;) {
    const msg = await client.next();
    if (msg.type === "dataResponse" && msg.devices.find((d) => d.deviceId === deviceId)?.status === status) return;
  }
}

async function visit(deviceId, interval) {
  const token = await s.tokenFor("luis", deviceId);
  const client = await s.connect();
  client.send({ type: "authenticate", deviceId, token, interval });
  await client.next();
  client.send({ type: "updatePosition", latitude: 1, longitude: 2 });
  return client;
}

test("a device that reported stays online after its socket closed, for two report periods", async () => {
  const watcher = await s.device("luis", "watcher");
  const visitor = await visit("phone", 1000);
  await until(watcher, "phone", "online");
  const closedAt = Date.now();
  visitor.ws.close();

  await until(watcher, "phone", "offline");
  const graceMs = 2 * 1000 + config.onlineGrace.slackMs;
  assert.ok(Date.now() - closedAt >= graceMs - 400, `offline after ${Date.now() - closedAt} ms, grace is ${graceMs} ms`);
});

test("a device that never reported goes offline as soon as its socket closes", async () => {
  const watcher = await s.device("luis", "watcher");
  const token = await s.tokenFor("luis", "tablet");
  const client = await s.connect();
  client.send({ type: "authenticate", deviceId: "tablet", token, interval: 1000 });
  await client.next();
  await until(watcher, "tablet", "online");
  client.ws.close();
  await until(watcher, "tablet", "offline");
});

test("an interval outside one second to one hour closes the socket", async () => {
  const token = await s.tokenFor("luis", "phone");
  const client = await s.connect();
  client.send({ type: "authenticate", deviceId: "phone", token, interval: 10 });
  assert.equal((await client.closed).code, 1007);
});

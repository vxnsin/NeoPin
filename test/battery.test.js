import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";

let s;

beforeEach(async () => {
  s = await startServer();
  await s.account("luis");
});

afterEach(() => s.stop());

// Waits for the broadcast that carries the given device with a battery.
async function batteryOf(client, deviceId) {
  for (;;) {
    const msg = await client.next();
    const device = msg.type === "dataResponse" && msg.devices.find((d) => d.deviceId === deviceId);
    if (device?.battery) return device.battery;
  }
}

test("a device without a battery report shows none", async () => {
  const phone = await s.device("luis", "phone");
  const list = await phone.next();
  assert.equal(list.devices[0].battery, null);
});

test("the battery rides along with a position and reaches the other devices", async () => {
  const a = await s.device("luis", "a");
  await a.next();
  const b = await s.device("luis", "b");
  await b.next();

  b.send({ type: "updatePosition", latitude: 48.1, longitude: 11.5, battery: { level: 64, charging: false } });
  const battery = await batteryOf(a, "b");
  assert.equal(battery.level, 64);
  assert.equal(battery.charging, false);
  assert.ok(Date.parse(battery.updatedAt));
});

test("a phone lying on the charger reports its battery without a new position", async () => {
  const a = await s.device("luis", "a");
  await a.next();
  const b = await s.device("luis", "b");
  await b.next();

  b.send({ type: "updateBattery", level: 100, charging: true });
  const battery = await batteryOf(a, "b");
  assert.equal(battery.level, 100);
  assert.equal(battery.charging, true);
});

test("the dashboard API lists the battery too", async () => {
  const cookie = await s.cookieFor("luis");
  const phone = await s.device("luis", "phone");
  await phone.next();
  phone.send({ type: "updateBattery", level: 12, charging: false });
  await batteryOf(phone, "phone");

  const res = await fetch(`${s.baseUrl}/api/getData`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const devices = await res.json();
  assert.equal(devices.find((d) => d.deviceId === "phone").battery.level, 12);
});

test("an offline device keeps its last reading", async () => {
  const a = await s.device("luis", "a");
  await a.next();
  const b = await s.device("luis", "b");
  await b.next();
  b.send({ type: "updateBattery", level: 9, charging: false });
  await batteryOf(a, "b");

  b.ws.close();
  for (;;) {
    const msg = await a.next();
    const device = msg.type === "dataResponse" && msg.devices.find((d) => d.deviceId === "b");
    if (device?.status === "offline") {
      assert.equal(device.battery.level, 9);
      assert.ok(Date.parse(device.battery.updatedAt));
      break;
    }
  }
});

test("the last reading survives a server restart", async () => {
  const { resetDevices, serializeDevices } = await import("../src/devices.js");
  const phone = await s.device("luis", "phone");
  await phone.next();
  phone.send({ type: "updateBattery", level: 42, charging: true });
  await batteryOf(phone, "phone");

  resetDevices(); // what a restart does to the in-memory registry
  const device = serializeDevices().find((d) => d.deviceId === "phone");
  assert.equal(device.status, "offline");
  assert.deepEqual({ level: device.battery.level, charging: device.battery.charging }, { level: 42, charging: true });
});

test("a battery level outside 0 to 100 closes the socket", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  phone.send({ type: "updateBattery", level: 140, charging: false });
  assert.equal((await phone.closed).code, 1007);
});

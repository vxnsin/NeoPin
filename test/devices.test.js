import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../src/accounts.js";
import { initDb } from "../src/db.js";
import {
  attachSocket,
  detachSocket,
  getDevice,
  resetDevices,
  serializeDevices,
  timeAgo,
  updatePosition,
} from "../src/devices.js";

const fakeSocket = () => ({ readyState: 1, OPEN: 1 });
let userId;

beforeEach(() => {
  initDb(":memory:");
  resetDevices();
  userId = createUser({ username: "luis", password: "correct-horse" }).id;
});

test("a new device starts online without a position", () => {
  attachSocket(userId, "phone", fakeSocket());
  assert.deepEqual(serializeDevices(), [
    {
      deviceId: "phone",
      userId,
      owner: { username: "luis", displayName: "luis" },
      position: null,
      lastPing: null,
      status: "online",
      battery: null,
      avatarUrl: null,
      deviceType: "phone",
      primary: false,
      groupIds: [],
    },
  ]);
});

test("a device remembers the type it announced", () => {
  attachSocket(userId, "mac", fakeSocket(), "desktop");
  attachSocket(userId, "mac", fakeSocket());
  assert.equal(serializeDevices()[0].deviceType, "desktop");
});

test("reconnecting returns the socket that was replaced and keeps the position", () => {
  const first = fakeSocket();
  const second = fakeSocket();
  attachSocket(userId, "phone", first);
  updatePosition(userId, "phone", 1, 2);

  const replaced = attachSocket(userId, "phone", second);

  assert.equal(replaced, first);
  assert.deepEqual(getDevice(userId, "phone").position, { latitude: 1, longitude: 2 });
  assert.equal(getDevice(userId, "phone").status, "online");
});

test("closing an old socket does not mark a reconnected device offline", () => {
  const first = fakeSocket();
  const second = fakeSocket();
  attachSocket(userId, "phone", first);
  attachSocket(userId, "phone", second);

  assert.equal(detachSocket(userId, "phone", first), false);
  assert.equal(getDevice(userId, "phone").status, "online");

  assert.equal(detachSocket(userId, "phone", second), true);
  assert.equal(getDevice(userId, "phone").status, "offline");
});

test("the same device name under two accounts stays two devices", () => {
  const other = createUser({ username: "anna", password: "correct-horse" }).id;
  attachSocket(userId, "phone", fakeSocket());
  attachSocket(other, "phone", fakeSocket());
  updatePosition(userId, "phone", 1, 2);

  const all = serializeDevices();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((d) => d.owner.username), ["luis", "anna"]);
  assert.equal(all.find((d) => d.userId === other).position, null);
});

test("timeAgo picks the largest fitting unit", () => {
  const now = Date.now();
  assert.equal(timeAgo(new Date(now - 5_000).toISOString()), "5 seconds ago");
  assert.equal(timeAgo(new Date(now - 61_000).toISOString()), "1 minute ago");
  assert.equal(timeAgo(new Date(now - 2 * 3_600_000).toISOString()), "2 hours ago");
});

test("a device that is offline and no longer linked drops out of the list", async () => {
  const { issueToken } = await import("../src/accounts.js");
  const socket = fakeSocket();
  attachSocket(userId, "phone", socket);
  issueToken(userId, "phone");
  detachSocket(userId, "phone", socket);
  assert.equal(serializeDevices().length, 1, "still linked");

  const { setPassword } = await import("../src/accounts.js");
  setPassword(userId, "another-password");
  assert.equal(serializeDevices().length, 0, "login revoked");
});

test("linked devices are listed after a restart with their last stored position", async () => {
  const { issueToken } = await import("../src/accounts.js");
  const { recordPosition } = await import("../src/history.js");
  issueToken(userId, "phone", "tablet");
  recordPosition(userId, "phone", 48.1, 11.5, Date.UTC(2025, 5, 10, 9));
  resetDevices(); // what a restart does to the in-memory registry

  const [device] = serializeDevices();
  assert.equal(device.deviceId, "phone");
  assert.equal(device.status, "offline");
  assert.equal(device.deviceType, "tablet");
  assert.deepEqual(device.position, { latitude: 48.1, longitude: 11.5 });
  assert.equal(device.lastPing, "2025-06-10T09:00:00.000Z");
});

test("a device without a announced type is told apart by its name", async () => {
  const { inferDeviceType } = await import("../src/accounts.js");
  assert.equal(inferDeviceType("iPad"), "tablet");
  assert.equal(inferDeviceType("Luis' iPad Pro"), "tablet");
  assert.equal(inferDeviceType("Galaxy Tab S9"), "tablet");
  assert.equal(inferDeviceType("MacBook Pro"), "desktop");
  assert.equal(inferDeviceType("iPhone"), "phone");
  assert.equal(inferDeviceType("Nothing Phone (3)"), "phone");
});

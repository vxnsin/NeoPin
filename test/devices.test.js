import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
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

beforeEach(() => resetDevices());

test("a new device starts online without a position", () => {
  attachSocket("phone", fakeSocket());
  assert.deepEqual(serializeDevices(), [
    { deviceId: "phone", position: null, lastPing: null, status: "online" },
  ]);
});

test("reconnecting returns the socket that was replaced and keeps the position", () => {
  const first = fakeSocket();
  const second = fakeSocket();
  attachSocket("phone", first);
  updatePosition("phone", 1, 2);

  const replaced = attachSocket("phone", second);

  assert.equal(replaced, first);
  assert.deepEqual(getDevice("phone").position, { latitude: 1, longitude: 2 });
  assert.equal(getDevice("phone").status, "online");
});

test("closing an old socket does not mark a reconnected device offline", () => {
  const first = fakeSocket();
  const second = fakeSocket();
  attachSocket("phone", first);
  attachSocket("phone", second);

  assert.equal(detachSocket("phone", first), false);
  assert.equal(getDevice("phone").status, "online");

  assert.equal(detachSocket("phone", second), true);
  assert.equal(getDevice("phone").status, "offline");
});

test("timeAgo picks the largest fitting unit", () => {
  const now = Date.now();
  assert.equal(timeAgo(new Date(now - 5_000).toISOString()), "5 seconds ago");
  assert.equal(timeAgo(new Date(now - 61_000).toISOString()), "1 minute ago");
  assert.equal(timeAgo(new Date(now - 2 * 3_600_000).toISOString()), "2 hours ago");
});

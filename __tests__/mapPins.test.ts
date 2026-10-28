import type { Device } from "../lib/devices";
import { pinKinds } from "../lib/mapPins";

const dev = (deviceId: string, userId: number, status: "online" | "offline", deviceType: Device["deviceType"], primary = false): Device => ({
  deviceId,
  userId,
  owner: { username: `user${userId}`, displayName: `User ${userId}` },
  position: { latitude: 49.8, longitude: 9.9 },
  lastPing: "2026-10-28T20:00:00.000Z",
  status,
  deviceType,
  primary,
});

test("the primary device carries the avatar, online extras are chips, offline extras stay off the map", () => {
  const kinds = pinKinds([dev("iPad", 1, "online", "tablet"), dev("MacBook", 1, "offline", "desktop"), dev("iPhone", 1, "online", "phone", true)]);
  expect(kinds.get("1:iPhone")).toBe("avatar");
  expect(kinds.get("1:iPad")).toBe("chip");
  expect(kinds.get("1:MacBook")).toBe("hidden");
});

test("an offline primary hands the avatar to the device that is online", () => {
  const kinds = pinKinds([dev("iPhone", 1, "offline", "phone", true), dev("iPad", 1, "online", "tablet")]);
  expect(kinds.get("1:iPad")).toBe("avatar");
  expect(kinds.get("1:iPhone")).toBe("hidden");
});

test("each person gets their own avatar, a single device is one whatever its state", () => {
  const kinds = pinKinds([dev("Pixel", 2, "offline", "phone"), dev("iPhone", 1, "online", "phone")]);
  expect(kinds.get("2:Pixel")).toBe("avatar");
  expect(kinds.get("1:iPhone")).toBe("avatar");
});

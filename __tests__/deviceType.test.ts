import { deviceTypeFrom, resolveDeviceType } from "../lib/deviceType";
import { typeOf } from "../lib/devices";

test("expo-device types map to the server's names", () => {
  expect(deviceTypeFrom(1)).toBe("phone");
  expect(deviceTypeFrom(2)).toBe("tablet");
  expect(deviceTypeFrom(3)).toBe("desktop");
  expect(deviceTypeFrom(0)).toBe("phone");
  expect(deviceTypeFrom(4)).toBe("phone");
  expect(deviceTypeFrom(null)).toBe("phone");
});

test("a device without a known type is a phone", () => {
  expect(typeOf({})).toBe("phone");
  expect(typeOf({ deviceType: "desktop" })).toBe("desktop");
  expect(typeOf({ deviceType: "toaster" })).toBe("phone");
});

import { groupByOwner, type Device } from "../lib/devices";

const dev = (userId: number, deviceId: string, status: "online" | "offline"): Device => ({
  deviceId,
  userId,
  position: null,
  lastPing: null,
  status,
});

test("the avatar stack shows one entry per owner with the best state and a count of the rest", () => {
  const groups = groupByOwner([dev(1, "a", "offline"), dev(2, "x", "online"), dev(1, "b", "online"), dev(1, "c", "offline")]);
  expect(groups.map((g) => [g.device.userId, g.device.deviceId, g.extra])).toEqual([
    [1, "b", 2],
    [2, "x", 0],
  ]);
});

test("an iPad reported as a phone still counts as a tablet", () => {
  expect(resolveDeviceType({ reported: 1, isPad: true })).toBe("tablet");
  expect(resolveDeviceType({ reported: 0, modelName: "iPad Pro 11-inch" })).toBe("tablet");
  expect(resolveDeviceType({ reported: 1, modelName: "iPhone 15" })).toBe("phone");
  expect(resolveDeviceType({ reported: 3 })).toBe("desktop");
});

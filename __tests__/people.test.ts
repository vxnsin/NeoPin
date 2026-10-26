import { groupByOwner, groupPeople, primaryDevice, statusText, type Device } from "../lib/devices";

const dev = (
  userId: number | undefined,
  deviceId: string,
  status: "online" | "offline",
  deviceType: any,
  lastPing: string | null = null,
  name?: string
): Device => ({
  deviceId,
  userId,
  owner: name ? { username: name.toLowerCase(), displayName: name } : undefined,
  position: null,
  lastPing,
  status,
  deviceType,
});

test("the primary device is the online one, then phone over tablet over desktop, then the latest ping", () => {
  const mac = dev(1, "Mac", "offline", "desktop", "2025-06-10T10:00:00Z");
  const pad = dev(1, "iPad", "offline", "tablet", "2025-06-10T09:00:00Z");
  const phone = dev(1, "iPhone", "offline", "phone", "2025-06-01T09:00:00Z");
  const phone2 = dev(1, "Pixel", "offline", "phone", "2025-06-05T09:00:00Z");
  expect(primaryDevice([mac, pad, phone])?.deviceId).toBe("iPhone");
  expect(primaryDevice([mac, pad])?.deviceId).toBe("iPad");
  expect(primaryDevice([phone, phone2])?.deviceId).toBe("Pixel");
  expect(primaryDevice([phone, { ...mac, status: "online" }])?.deviceId).toBe("Mac");
  expect(primaryDevice([])).toBeUndefined();
});

test("people are grouped once, own account first, then online people, then the rest", () => {
  const people = groupPeople(
    [
      dev(3, "d1", "offline", "phone", null, "Zoe"),
      dev(2, "d2", "online", "phone", null, "Bea"),
      dev(1, "d3", "offline", "phone", null, "Luis"),
      dev(2, "d4", "offline", "tablet", null, "Bea"),
      dev(1, "d5", "offline", "tablet", null, "Luis"),
      dev(4, "d6", "online", "phone", null, "Al"),
    ],
    1
  );
  expect(people.map((p) => [p.name, p.devices.length, p.extra])).toEqual([
    ["Luis", 2, 1],
    ["Al", 1, 0],
    ["Bea", 2, 1],
    ["Zoe", 1, 0],
  ]);
  expect(people[0].isMe).toBe(true);
  expect(people[2].primary.deviceId).toBe("d2");
});

test("the avatar stack has one entry per person, offline devices included", () => {
  const groups = groupByOwner(
    [dev(1, "a", "offline", "phone"), dev(2, "x", "online", "phone"), dev(1, "b", "offline", "tablet"), dev(1, "c", "offline", "desktop")],
    1
  );
  expect(groups.map((g) => [g.device.userId, g.device.deviceId, g.extra])).toEqual([
    [1, "a", 2],
    [2, "x", 0],
  ]);
});

test("status text says online or when the device was last seen", () => {
  const ago = (t: string | null) => `ago:${t}`;
  expect(statusText(dev(1, "a", "online", "phone"), ago)).toBe("online");
  expect(statusText(dev(1, "a", "offline", "phone", "T"), ago)).toBe("ago:T");
  expect(statusText(dev(1, "a", "offline", "phone"), ago)).toBe("no position yet");
});

test("devices without a user id still group by owner name", () => {
  const a = dev(undefined, "a", "online", "phone", null, "Luis");
  const b = dev(undefined, "b", "offline", "tablet", null, "Luis");
  expect(groupPeople([a, b])).toHaveLength(1);
});

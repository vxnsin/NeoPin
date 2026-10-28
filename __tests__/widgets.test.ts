// The native module is absent in tests, like in a build from before the widgets existed.
jest.mock("../modules/neopin-widgets", () => ({ WidgetsNative: null }));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import { buildSnapshot, clearWidgets, initialsOf, parseWidgetAction, pushWidgets, widgetsAvailable } from "../lib/widgets";
import type { Device, Person } from "../lib/devices";

const device = (over: Partial<Device>): Device => ({
  deviceId: "phone",
  position: null,
  lastPing: "2026-10-28T12:00:00.000Z",
  status: "online",
  ...over,
});

const person = (over: Partial<Person> & { primary: Device }): Person => ({
  key: `user:${over.userId ?? 0}`,
  name: "Somebody",
  isMe: false,
  online: over.primary.status === "online",
  devices: [over.primary],
  extra: 0,
  ...over,
});

const me = person({ userId: 1, name: "Luis", isMe: true, primary: device({ userId: 1, position: { latitude: 49.7937, longitude: 9.9387 }, battery: { level: 71, charging: false } }) });
// About 420 m north-east.
const anna = person({ userId: 2, name: "Anna Berg", primary: device({ userId: 2, position: { latitude: 49.7964, longitude: 9.9428 }, battery: { level: 40, charging: true }, groupIds: [1, 2] }) });
const mia = person({ userId: 3, name: "Mia", primary: device({ userId: 3, status: "offline", position: { latitude: 49.79, longitude: 9.93 }, battery: { level: 90, charging: false }, lastPing: null }) });
const kaspar = person({ userId: 4, name: "Kaspar", primary: device({ userId: 4, position: null }) });
const user = { id: 1, username: "luis", displayName: "Luis", avatarUrl: null, hiddenUntil: null };

test("initials come from the first and the last name", () => {
  expect(initialsOf("Anna Berg")).toBe("AB");
  expect(initialsOf("anna")).toBe("A");
  expect(initialsOf("  ")).toBe("?");
  expect(initialsOf("Émile de la Cruz")).toBe("ÉC");
});

test("the snapshot leaves me out, sorts online and near first and keeps batteries only while online", () => {
  const snap = buildSnapshot([me, mia, kaspar, anna], [{ id: 1, name: "Everyone" } as any], user, true, 5000);
  expect(snap.updatedAt).toBe(5000);
  expect(snap.me).toEqual({ name: "Luis", hiddenUntil: null, battery: 71, sharing: true });
  expect(snap.people.map((p) => p.name)).toEqual(["Anna Berg", "Kaspar", "Mia"]);
  const [a, k, m] = snap.people;
  expect(a).toMatchObject({ id: "user:2", userId: 2, initials: "AB", online: true, battery: 40, groupIds: [1, 2] });
  expect(a.distanceM).toBeGreaterThan(400);
  expect(a.distanceM).toBeLessThan(450);
  expect(a.lastPing).toBe(Date.parse("2026-10-28T12:00:00.000Z"));
  // No position on their side: no distance, but still listed.
  expect(k.distanceM).toBeNull();
  // Offline: the old battery reading is not shown, and no ping time without one.
  expect(m).toMatchObject({ online: false, battery: null, lastPing: null });
  expect(snap.groups).toEqual([{ id: 1, name: "Everyone" }]);
});

test("without my own position nobody has a distance, without a user there is no me", () => {
  const snap = buildSnapshot([anna], [], null, false);
  expect(snap.me).toBeNull();
  expect(snap.people[0].distanceM).toBeNull();
});

test("widget links turn into actions", () => {
  expect(parseWidgetAction({ hide: "60" })).toEqual({ kind: "hide", minutes: 60 });
  expect(parseWidgetAction({ hide: "0" })).toEqual({ kind: "show" });
  expect(parseWidgetAction({ hide: "-5" })).toBeNull();
  expect(parseWidgetAction({ find: "7" })).toEqual({ kind: "find", userId: 7 });
  expect(parseWidgetAction({ find: "x" })).toBeNull();
  expect(parseWidgetAction({ person: ["user:2"] })).toEqual({ kind: "person", id: "user:2" });
  expect(parseWidgetAction({})).toBeNull();
});

test("without the native module nothing is pushed and nothing breaks", () => {
  expect(widgetsAvailable()).toBe(false);
  expect(pushWidgets(buildSnapshot([anna], [], user, true))).toBe(false);
  expect(() => clearWidgets()).not.toThrow();
});

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import { badgeText, chipGroups, filterByGroup, loadGroupFilter, pendingCount, resolveGroupFilter, saveGroupFilter, showGroupChips } from "../lib/groups";
import { groupPeople, type Device } from "../lib/devices";

const dev = (userId: number, deviceId: string, groupIds?: number[]): Device => ({
  deviceId,
  userId,
  owner: { username: "u" + userId, displayName: "U" + userId },
  position: null,
  lastPing: null,
  status: "online",
  groupIds,
});

const devices = [dev(1, "mine", []), dev(2, "a", [10]), dev(2, "a2", [10, 11]), dev(3, "b", [11]), dev(4, "c", [])];

test("All keeps everything", () => {
  expect(filterByGroup(devices, null, 1)).toHaveLength(5);
});

test("a group keeps its people and the own devices", () => {
  expect(filterByGroup(devices, 10, 1).map((d) => d.deviceId)).toEqual(["mine", "a", "a2"]);
  expect(filterByGroup(devices, 11, 1).map((d) => d.deviceId)).toEqual(["mine", "a2", "b"]);
  expect(filterByGroup(devices, 11).map((d) => d.deviceId)).toEqual(["a2", "b"]);
});

test("people are built from the filtered devices", () => {
  expect(groupPeople(filterByGroup(devices, 10, 1), 1).map((p) => p.userId)).toEqual([1, 2]);
});

test("a vanished group falls back to All", () => {
  expect(resolveGroupFilter(10, [{ id: 10 }, { id: 11 }])).toBe(10);
  expect(resolveGroupFilter(12, [{ id: 10 }])).toBeNull();
  expect(resolveGroupFilter(null, [])).toBeNull();
});

test("the fixed group is All: no chip of its own, a saved pick of it falls back to All", () => {
  const everyone = { id: 1, fixed: true };
  const friends = { id: 2, fixed: false };
  expect(chipGroups([everyone, friends])).toEqual([friends]);
  expect(resolveGroupFilter(1, [everyone, friends])).toBeNull();
  expect(resolveGroupFilter(2, [everyone, friends])).toBe(2);
});

test("chips only when one would show something All does not", () => {
  const everyone = { fixed: true };
  const group = { fixed: false };
  // Everyone alone, or Everyone next to nothing else: All says it all.
  expect(showGroupChips([everyone])).toBe(false);
  // A group next to Everyone shows fewer people than All.
  expect(showGroupChips([everyone, group])).toBe(true);
  // One group and no fixed one: All is that group.
  expect(showGroupChips([group])).toBe(false);
  // Two groups to pick between, with or without a fixed one.
  expect(showGroupChips([group, group])).toBe(true);
  expect(showGroupChips([everyone, group, group])).toBe(true);
  // Older servers send no flag: every group counts as its own.
  expect(showGroupChips([{ id: 1 } as any])).toBe(false);
  expect(showGroupChips([{ id: 1 } as any, { id: 2 } as any])).toBe(true);
});

test("the badge counts open invitations", () => {
  expect(pendingCount([])).toBe(0);
  expect(pendingCount([{ id: 1 } as any, { id: 2 } as any])).toBe(2);
  expect(badgeText(3)).toBe("3");
  expect(badgeText(12)).toBe("9+");
});

test("the chosen group is remembered", async () => {
  expect(await loadGroupFilter()).toBeNull();
  await saveGroupFilter(11);
  expect(await loadGroupFilter()).toBe(11);
  await saveGroupFilter(null);
  expect(await loadGroupFilter()).toBeNull();
});

import { contactsFrom, pruneRecipients, toggleId } from "../lib/recipients";

const member = (id: number, displayName: string) => ({ id, username: displayName.toLowerCase(), displayName, avatarUrl: null, role: "member" as const });

test("contacts are everyone in my groups, once each, by name and without me", () => {
  const groups = [
    { members: [member(1, "Luis"), member(3, "Leo"), member(2, "kaspar")] },
    { members: [member(1, "Luis"), member(3, "Leo"), member(4, "Anna")] },
  ];
  expect(contactsFrom(groups, 1).map((c) => c.id)).toEqual([4, 2, 3]);
  expect(contactsFrom([], 1)).toEqual([]);
});

test("a chip toggles its id", () => {
  expect(toggleId([1, 2], 2)).toEqual([1]);
  expect(toggleId([1], 3)).toEqual([1, 3]);
});

test("people and groups that are gone are dropped before saving", () => {
  const value = { users: [2, 9], groups: [5, 6] };
  expect(pruneRecipients(value, [{ id: 2 }], [{ id: 5 }], true)).toEqual({ users: [2], groups: [5] });
  // Groups not loaded yet: nothing is known, nothing is dropped.
  expect(pruneRecipients(value, [], [], false)).toEqual(value);
  // Loaded and none left: everything goes, or every save would fail on the stale ids.
  expect(pruneRecipients(value, [], [], true)).toEqual({ users: [], groups: [] });
});

import { notificationDetail, notificationTitle, unreadCount, unreadIds } from "../lib/notifications";
import type { AppNotification } from "../lib/api";

const item = (id: number, readAt: string | null, groupName: string | null = null): AppNotification => ({
  id,
  type: "inviteUsed",
  createdAt: "T",
  readAt,
  data: {
    user: { id: 5, username: "ben", displayName: "Ben", avatarUrl: null },
    invitedBy: { id: 1, username: "anna", displayName: "Anna" },
    groupName,
  },
});

test("only unread items count", () => {
  const items = [item(1, null), item(2, "x"), item(3, null)];
  expect(unreadCount(items)).toBe(2);
  expect(unreadIds(items)).toEqual([1, 3]);
  expect(unreadCount([])).toBe(0);
});

test("an item reads as a sentence with group and time", () => {
  expect(notificationTitle(item(1, null))).toBe("Ben joined with Anna's invite code");
  expect(notificationDetail(item(1, null, "Family"), () => "10:00")).toBe("Family · 10:00");
  expect(notificationDetail(item(1, null), () => "10:00")).toBe("10:00");
});

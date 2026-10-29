import {
  isReviewNotification,
  knownNotifications,
  notificationDetail,
  notificationPerson,
  notificationTitle,
  unreadCount,
  unreadIds,
} from "../lib/notifications";
import type { AppNotification, PlaceNotification, ReviewNotification } from "../lib/api";

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

const at = new Date(2026, 9, 29, 18, 2).getTime();

const place = (type: "arrived" | "left", data: Partial<PlaceNotification["data"]> = {}): PlaceNotification => ({
  id: 9,
  type,
  createdAt: "2026-10-29T17:03:00.000Z",
  readAt: null,
  data: { userId: 4, name: "Kaspar", placeId: 3, placeName: "Home", kind: "home", at, ...data },
});

const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

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

test("an arrival and a departure read with the place and the clock time", () => {
  expect(notificationTitle(place("arrived"), clock)).toBe("Kaspar arrived at Home · 18:02");
  expect(notificationTitle(place("left", { name: "Leo", placeName: "Work", kind: "work" }), clock)).toBe("Leo left Work · 18:02");
  expect(notificationDetail(place("arrived"), clock)).toBe("");
  // FCM-style string milliseconds and a place without a name.
  expect(notificationTitle(place("arrived", { at: String(at), placeName: "" }), clock)).toBe("Kaspar arrived at Home · 18:02");
  expect(notificationTitle(place("arrived"))).toBe("Kaspar arrived at Home");
});

test("the person of a notification is the one it is about", () => {
  expect(notificationPerson(place("arrived"))).toEqual({ userId: 4, name: "Kaspar", avatarUrl: undefined });
  expect(notificationPerson(item(1, null))).toEqual({ userId: 5, name: "Ben", avatarUrl: null });
});

test("kinds this app cannot draw are left out", () => {
  const unknown = { ...item(2, null), type: "somethingNew" } as unknown as AppNotification;
  expect(knownNotifications([item(1, null), unknown, place("left")]).map((n) => n.id)).toEqual([1, 9]);
});

const review = (data: Partial<ReviewNotification["data"]> = {}): ReviewNotification => ({
  id: 12,
  type: "review",
  createdAt: "2026-10-26T08:00:00.000Z",
  readAt: null,
  data: { period: "week", from: "2026-10-19", to: "2026-10-25", distanceKm: 84.2, ...data },
});

test("a review reads with its distance and its days, and is nobody's", () => {
  const now = new Date(2026, 9, 29);
  expect(knownNotifications([review()]).map((n) => n.id)).toEqual([12]);
  expect(isReviewNotification(review())).toBe(true);
  expect(isReviewNotification(place("left"))).toBe(false);
  expect(notificationTitle(review(), clock)).toBe("Your week: 84 km");
  expect(notificationTitle(review({ period: "month", distanceKm: 312 }))).toBe("Your month: 312 km");
  expect(notificationDetail(review(), clock, now)).toBe("19 – 25 Oct");
  // Only `from`: the days come from the period around it.
  expect(notificationDetail(review({ period: "month", from: "2026-09-01", to: "" }), clock, now)).toBe("1 – 30 Sep");
  expect(notificationPerson(review())).toBeNull();
});

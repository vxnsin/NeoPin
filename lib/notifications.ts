import type { AppNotification, PlaceNotification, ReviewNotification } from "@/lib/api";
import { PLACE_LABELS } from "@/lib/timeline";
import { isDayKey, periodRange, rangeLabel, reviewTitle } from "@/lib/review";

const KNOWN_TYPES: AppNotification["type"][] = ["inviteUsed", "arrived", "left", "review"];

// A newer server may know more kinds than this app can draw; those stay out of the list.
export function knownNotifications(items: AppNotification[]): AppNotification[] {
  return items.filter((item) => KNOWN_TYPES.includes(item.type));
}

export function isPlaceNotification(item: AppNotification): item is PlaceNotification {
  return item.type === "arrived" || item.type === "left";
}

export function isReviewNotification(item: AppNotification): item is ReviewNotification {
  return item.type === "review";
}

export function unreadIds(items: AppNotification[]): number[] {
  return items.filter((item) => !item.readAt).map((item) => item.id);
}

export function unreadCount(items: AppNotification[]): number {
  return unreadIds(items).length;
}

// The moment of an arrival as an ISO string for the clock. The server sends milliseconds; the time the
// notification was made stands in when that is missing.
function placeMoment(item: PlaceNotification): string {
  const at = typeof item.data.at === "string" && /^\d+$/.test(item.data.at) ? Number(item.data.at) : item.data.at;
  const date = new Date(at ?? item.createdAt);
  return Number.isNaN(date.getTime()) ? item.createdAt : date.toISOString();
}

// Whose notification it is: the person who joined, or the one who arrived or left. A review is nobody's.
export function notificationPerson(item: AppNotification): { userId: number; name: string; avatarUrl: string | null | undefined } | null {
  if (isReviewNotification(item)) return null;
  if (isPlaceNotification(item)) return { userId: item.data.userId, name: item.data.name, avatarUrl: item.data.avatarUrl };
  return { userId: item.data.user.id, name: item.data.user.displayName, avatarUrl: item.data.user.avatarUrl };
}

// "Kaspar arrived at Home · 18:02". An arrival carries its time in the title, so its detail line stays empty.
export function notificationTitle(item: AppNotification, when: (iso: string) => string = () => ""): string {
  if (isReviewNotification(item)) return reviewTitle(item.data.period === "month" ? "month" : "week", item.data.distanceKm);
  if (isPlaceNotification(item)) {
    const place = item.data.placeName || PLACE_LABELS[item.data.kind] || "a place";
    const sentence = item.type === "arrived" ? `${item.data.name} arrived at ${place}` : `${item.data.name} left ${place}`;
    const time = when(placeMoment(item));
    return time ? `${sentence} · ${time}` : sentence;
  }
  return `${item.data.user.displayName} joined with ${item.data.invitedBy.displayName}'s invite code`;
}

// A review names its days ("20 – 26 Oct"), falling back to the period around `from`.
export function notificationDetail(item: AppNotification, when: (iso: string) => string, now = new Date()): string {
  if (isReviewNotification(item)) {
    const { from, to } = item.data;
    if (isDayKey(from) && isDayKey(to)) return rangeLabel(from, to, now);
    if (isDayKey(from)) {
      const range = periodRange(item.data.period === "month" ? "month" : "week", from);
      return rangeLabel(range.from, range.to, now);
    }
    return when(item.createdAt);
  }
  if (isPlaceNotification(item)) return "";
  const group = item.data.groupName ? `${item.data.groupName} · ` : "";
  return `${group}${when(item.createdAt)}`;
}

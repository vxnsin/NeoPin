import type { AppNotification } from "@/lib/api";

export function unreadIds(items: AppNotification[]): number[] {
  return items.filter((item) => !item.readAt).map((item) => item.id);
}

export function unreadCount(items: AppNotification[]): number {
  return unreadIds(items).length;
}

export function notificationTitle(item: AppNotification): string {
  return `${item.data.user.displayName} joined with ${item.data.invitedBy.displayName}'s invite code`;
}

export function notificationDetail(item: AppNotification, when: (iso: string) => string): string {
  const group = item.data.groupName ? `${item.data.groupName} · ` : "";
  return `${group}${when(item.createdAt)}`;
}

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Group, Invite } from "@/lib/api";
import type { Device } from "@/lib/devices";

const FILTER_KEY = "groupFilter";

// null is "All". A person's own devices always stay, they carry no group of their own.
export function filterByGroup(devices: Device[], groupId: number | null, myUserId?: number): Device[] {
  if (groupId === null) return devices;
  return devices.filter((d) => (myUserId !== undefined && d.userId === myUserId) || (d.groupIds ?? []).includes(groupId));
}

// A group that is gone falls back to All.
export function resolveGroupFilter(selected: number | null, groups: Pick<Group, "id">[]): number | null {
  return selected !== null && groups.some((g) => g.id === selected) ? selected : null;
}

export function showGroupChips(groups: Group[]): boolean {
  return groups.length > 1;
}

// What the badge counts: invitations waiting for an answer.
export function pendingCount(invites: Invite[]): number {
  return invites.length;
}

export function badgeText(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export async function loadGroupFilter(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(FILTER_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveGroupFilter(groupId: number | null): Promise<void> {
  try {
    if (groupId === null) await AsyncStorage.removeItem(FILTER_KEY);
    else await AsyncStorage.setItem(FILTER_KEY, String(groupId));
  } catch {
    // best effort
  }
}

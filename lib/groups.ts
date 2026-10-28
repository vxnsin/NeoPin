import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Group, Invite } from "@/lib/api";
import type { Device } from "@/lib/devices";

const FILTER_KEY = "groupFilter";

// null is "All". A person's own devices always stay, they carry no group of their own.
export function filterByGroup(devices: Device[], groupId: number | null, myUserId?: number): Device[] {
  if (groupId === null) return devices;
  return devices.filter((d) => (myUserId !== undefined && d.userId === myUserId) || (d.groupIds ?? []).includes(groupId));
}

// The groups that get a chip next to All. A fixed group holds every account, so it shows
// exactly what All shows and gets no chip of its own; it stays in the groups list.
export function chipGroups<T extends Pick<Group, "fixed">>(groups: T[]): T[] {
  return groups.filter((g) => !g.fixed);
}

// A group that is gone falls back to All, and so does the fixed one, which is the same as All.
export function resolveGroupFilter(selected: number | null, groups: Pick<Group, "id" | "fixed">[]): number | null {
  return selected !== null && chipGroups(groups).some((g) => g.id === selected) ? selected : null;
}

// Chips only when a chip would show something All does not: two groups to pick between, or
// one next to a fixed group (then All is everybody and the group fewer). With a single group
// and nothing else, All already is that group.
export function showGroupChips(groups: Pick<Group, "fixed">[]): boolean {
  const own = chipGroups(groups);
  return own.length >= 2 || (own.length === 1 && own.length < groups.length);
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

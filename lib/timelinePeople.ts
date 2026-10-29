import type { AccountSummary, TimelinePerson, TimelineSharing } from "@/lib/api";
import type { Device } from "@/lib/devices";

// Older servers have no list of shared timelines; the admin then picks from all accounts and their
// devices are asked for when one is picked (an empty list here).
export function peopleFromAccounts(accounts: AccountSummary[]): TimelinePerson[] {
  return accounts.map((account) => ({ userId: account.id, displayName: account.displayName, avatarUrl: account.avatarUrl, devices: [] }));
}

// The devices of a person whose timeline is open, with what the map knows about them (online, type),
// so their chips look like the own ones. Devices the map does not show stay plain.
export function devicesOf(person: TimelinePerson, mapDevices: Device[]): Device[] {
  return person.devices.map((deviceId) => {
    const known = mapDevices.find((d) => d.userId === person.userId && d.deviceId === deviceId);
    return known
      ? { ...known, avatarUrl: known.avatarUrl ?? person.avatarUrl }
      : { deviceId, userId: person.userId, position: null, lastPing: null, status: "offline", avatarUrl: person.avatarUrl };
  });
}

// Someone else's day is only read: the place picker, the corrections and "Not a stop" stay with the
// owner. The admin keeps them, as before.
export function canEditTimeline(viewingOther: boolean, admin: boolean): boolean {
  return !viewingOther || admin;
}

export const SHARING_CHOICES: { mode: TimelineSharing["mode"]; label: string; hint: string }[] = [
  { mode: "off", label: "Off", hint: "Only you see your timeline." },
  { mode: "groups", label: "Everyone in my groups", hint: "Everyone you share a group with can open your timeline." },
  { mode: "selected", label: "Selected people and groups", hint: "Only the people and groups you pick can open your timeline." },
];

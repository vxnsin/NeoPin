import type { Group } from "@/lib/api";

// People and groups picked for something that is shared: arrival alerts, a timeline.
export type Recipients = { users: number[]; groups: number[] };

export type Contact = { id: number; displayName: string; avatarUrl: string | null };

// Everyone who shares a group with me, once each and by name. Only they can be picked, the server
// refuses anyone else.
export function contactsFrom(groups: Pick<Group, "members">[], myUserId: number): Contact[] {
  const byId = new Map<number, Contact>();
  for (const group of groups) {
    for (const member of group.members) {
      if (member.id === myUserId || byId.has(member.id)) continue;
      byId.set(member.id, { id: member.id, displayName: member.displayName || member.username, avatarUrl: member.avatarUrl });
    }
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
}

export function toggleId(list: number[], id: number): number[] {
  return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
}

// Drops people and groups that are gone (someone left, a group was deleted), so saving does not fail
// on them. Without any groups loaded nothing is known yet, and everything stays.
export function pruneRecipients(value: Recipients, contacts: Pick<Contact, "id">[], groups: Pick<Group, "id">[]): Recipients {
  if (groups.length === 0) return value;
  const people = new Set(contacts.map((contact) => contact.id));
  const known = new Set(groups.map((group) => group.id));
  return { users: value.users.filter((id) => people.has(id)), groups: value.groups.filter((id) => known.has(id)) };
}

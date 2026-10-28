import { WidgetsNative } from "../modules/neopin-widgets";
import type { Group, User } from "./api";
import { batteryOf, type Person } from "./devices";
import { distanceM } from "./fixes";

// Home screen widgets. The app writes one small snapshot of what it knows into a store the
// widgets can read while it is closed. The widgets never talk to the server themselves; a tap
// on one of them opens the app with a link that says what to do.

export type WidgetPerson = {
  id: string;
  userId: number | null;
  name: string;
  initials: string;
  online: boolean;
  // From my own phone to theirs, null when one of the two has no position.
  distanceM: number | null;
  lastPing: number | null;
  // Whole percent, only while their phone is online.
  battery: number | null;
  groupIds: number[];
};

export type WidgetMe = { name: string; hiddenUntil: number | null; battery: number | null; sharing: boolean };

export type WidgetSnapshot = {
  updatedAt: number;
  me: WidgetMe | null;
  people: WidgetPerson[];
  groups: { id: number; name: string }[];
};

// "Anna Berg" → "AB", "anna" → "A".
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = [...parts[0]][0];
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] : "";
  return (first + last).toUpperCase();
}

// The people list of the app as the widgets want it: everybody but me, online first, then by
// distance, then by name.
export function buildSnapshot(people: Person[], groups: Group[], user: User | null, sharing: boolean, now = Date.now()): WidgetSnapshot {
  const me = people.find((p) => p.isMe) ?? null;
  const mine = me?.primary.position ?? null;
  const others: WidgetPerson[] = people
    .filter((p) => !p.isMe)
    .map((p) => {
      const theirs = p.primary.position;
      const ping = p.primary.lastPing ? Date.parse(p.primary.lastPing) : NaN;
      return {
        id: p.key,
        userId: p.userId ?? null,
        name: p.name,
        initials: initialsOf(p.name),
        online: p.online,
        distanceM: mine && theirs ? Math.round(distanceM(mine, theirs)) : null,
        lastPing: Number.isFinite(ping) ? ping : null,
        battery: batteryOf(p.primary)?.level ?? null,
        groupIds: [...new Set(p.devices.flatMap((d) => d.groupIds ?? []))],
      };
    })
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) || (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity) || a.name.localeCompare(b.name)
    );
  return {
    updatedAt: now,
    me: user
      ? { name: user.displayName, hiddenUntil: user.hiddenUntil ?? null, battery: me ? (batteryOf(me.primary)?.level ?? null) : null, sharing }
      : null,
    people: others,
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
  };
}

// What a widget asks the app to do when tapped. The links are neopin://map?hide=60,
// neopin://map?hide=0 (show me again), neopin://map?find=<userId> and neopin://map?person=<id>.
export type WidgetAction = { kind: "hide"; minutes: number } | { kind: "show" } | { kind: "find"; userId: number } | { kind: "person"; id: string };

export function parseWidgetAction(params: { hide?: string | string[]; find?: string | string[]; person?: string | string[] }): WidgetAction | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const hide = one(params.hide);
  if (hide !== undefined) {
    const minutes = Number(hide);
    if (!Number.isFinite(minutes) || minutes < 0) return null;
    return minutes === 0 ? { kind: "show" } : { kind: "hide", minutes: Math.round(minutes) };
  }
  const find = one(params.find);
  if (find !== undefined) {
    const userId = Number(find);
    return Number.isInteger(userId) && userId > 0 ? { kind: "find", userId } : null;
  }
  const person = one(params.person);
  if (person) return { kind: "person", id: person };
  return null;
}

export const widgetsAvailable = () => WidgetsNative !== null;

// Hands the snapshot to the widgets when something they show changed. The time stamp alone
// does not count, or every tick would redraw them.
let lastKey = "";
function keyOf(snapshot: WidgetSnapshot): string {
  return JSON.stringify({ ...snapshot, updatedAt: 0 });
}

export function pushWidgets(snapshot: WidgetSnapshot): boolean {
  if (!WidgetsNative) return false;
  const key = keyOf(snapshot);
  if (key === lastKey) return false;
  lastKey = key;
  WidgetsNative.update(JSON.stringify(snapshot)).catch(() => {});
  return true;
}

// After a logout the widgets show nothing instead of yesterday's friends.
export function clearWidgets() {
  lastKey = "";
  WidgetsNative?.update("").catch(() => {});
}

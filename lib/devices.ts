export type DeviceType = "phone" | "tablet" | "desktop";

export const DEVICE_ICONS: Record<DeviceType, "smartphone" | "tablet" | "computer"> = {
  phone: "smartphone",
  tablet: "tablet",
  desktop: "computer",
};

// Older servers send no type, those devices are phones.
export function typeOf(device: { deviceType?: string | null }): DeviceType {
  return device.deviceType === "tablet" || device.deviceType === "desktop" ? device.deviceType : "phone";
}

export type Device = {
  deviceId: string;
  userId?: number;
  owner?: { username: string; displayName: string };
  position: { latitude: number; longitude: number } | null;
  lastPing: string | null;
  status: "online" | "offline";
  avatarUrl?: string | null;
  deviceType?: DeviceType;
  // Ids of the groups this device shares with the signed-in account.
  groupIds?: number[];
  // The last charge the device reported, null until it did. Older servers send none.
  battery?: DeviceBattery | null;
};

export type DeviceBattery = { level: number; charging: boolean; updatedAt?: string };

// Only while the device is online: the last reading of a phone that went offline would only mislead.
export function batteryOf(device: Pick<Device, "battery" | "status">): DeviceBattery | null {
  return device.status === "online" && device.battery ? device.battery : null;
}

// Device names are only unique per account.
export function deviceKey(device: Pick<Device, "deviceId" | "userId">): string {
  return `${device.userId ?? ""}:${device.deviceId}`;
}

export function isOwnDevice(device: Pick<Device, "deviceId" | "userId">, userId: number | undefined, deviceId: string | undefined): boolean {
  return device.userId === userId && device.deviceId === deviceId;
}

// "Luis · iPhone": the owner first, so devices of different people do not look alike.
export function deviceLabel(device: Pick<Device, "deviceId" | "owner">): string {
  return device.owner?.displayName ? `${device.owner.displayName} \u00b7 ${device.deviceId}` : device.deviceId;
}

// Initials and colour follow the owner, like the picture does.
export function ownerName(device: Pick<Device, "deviceId" | "owner">): string {
  return device.owner?.displayName || device.deviceId;
}

export type Freshness = "online" | "stale" | "offline";

export const STALE_AFTER_MS = 10 * 60 * 1000;

// The status ring: green while a device reports, yellow once its position is old, grey offline.
export const STATE_COLORS: Record<Freshness, string> = {
  online: "#22c55e",
  stale: "#eab308",
  offline: "#9ca3af",
};

export function freshness(device: Device, now = Date.now()): Freshness {
  if (device.status !== "online") return "offline";
  if (device.lastPing && now - new Date(device.lastPing).getTime() > STALE_AFTER_MS) return "stale";
  return "online";
}

export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.trim().slice(0, 2);
  return letters.toUpperCase() || "?";
}

// Same palette and hash as the dashboard, so a device has the same colour everywhere.
// No green or yellow, those belong to the status ring.
const AVATAR_COLORS = ["#e11d48", "#ea580c", "#0284c7", "#4f46e5", "#db2777", "#2563eb", "#7c3aed", "#c026d3"];

export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

const TYPE_RANK: Record<DeviceType, number> = { phone: 0, tablet: 1, desktop: 2 };

const pingTime = (device: Device) => (device.lastPing ? new Date(device.lastPing).getTime() || 0 : 0);

// The device that stands for its owner: the one online now, else phone over tablet over
// desktop, else the one that reported last.
export function comparePrimary(a: Device, b: Device): number {
  return (
    Number(b.status === "online") - Number(a.status === "online") ||
    TYPE_RANK[typeOf(a)] - TYPE_RANK[typeOf(b)] ||
    pingTime(b) - pingTime(a) ||
    a.deviceId.localeCompare(b.deviceId)
  );
}

export function primaryDevice(devices: Device[]): Device | undefined {
  return [...devices].sort(comparePrimary)[0];
}

export type Person = {
  key: string;
  userId?: number;
  name: string;
  isMe: boolean;
  online: boolean;
  // The owner's devices, the primary one first.
  devices: Device[];
  primary: Device;
  // Devices beyond the primary one.
  extra: number;
};

function personKey(device: Device): string {
  if (device.userId !== undefined) return `user:${device.userId}`;
  if (device.owner?.username) return `name:${device.owner.username}`;
  return `device:${deviceKey(device)}`;
}

// One entry per person. Order: the own account, then people with a device online, then the
// rest, each by name.
export function groupPeople(devices: Device[], myUserId?: number): Person[] {
  const groups = new Map<string, Device[]>();
  for (const device of devices) {
    const key = personKey(device);
    const list = groups.get(key);
    if (list) list.push(device);
    else groups.set(key, [device]);
  }
  const people: Person[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort(comparePrimary);
    const first = sorted[0];
    people.push({
      key,
      userId: first.userId,
      name:
        first.owner?.displayName ||
        first.owner?.username ||
        (first.userId !== undefined ? `User ${first.userId}` : first.deviceId),
      isMe: myUserId !== undefined && first.userId === myUserId,
      online: sorted.some((d) => d.status === "online"),
      devices: sorted,
      primary: first,
      extra: sorted.length - 1,
    });
  }
  return people.sort(
    (a, b) =>
      Number(b.isMe) - Number(a.isMe) ||
      Number(b.online) - Number(a.online) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

export type OwnerGroup = { device: Device; extra: number };

// What the avatar stack shows: one entry per person with their primary device and the count of the rest.
export function groupByOwner(devices: Device[], myUserId?: number): OwnerGroup[] {
  return groupPeople(devices, myUserId).map((person) => ({ device: person.primary, extra: person.extra }));
}

// "online", or when the device last reported.
export function statusText(device: Device, ago: (timestamp: string | null) => string): string {
  if (device.status === "online") return "online";
  return device.lastPing ? ago(device.lastPing) : "no position yet";
}

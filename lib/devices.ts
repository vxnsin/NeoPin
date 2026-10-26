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
};

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

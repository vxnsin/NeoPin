export type Device = {
  deviceId: string;
  position: { latitude: number; longitude: number } | null;
  lastPing: string | null;
  status: "online" | "offline";
  avatarUrl?: string | null;
};

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

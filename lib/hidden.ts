// Hiding from everyone else's map for a while. The server keeps the time, so it also ends on
// its own while the app is closed.

// What the server stores for "until I turn it off": the latest date JavaScript knows.
const FOREVER = 8_640_000_000_000_000;
const MAX_MINUTES = 7 * 24 * 60;

export type HideChoice = { key: string; label: string; minutes: (now: Date) => number | null };

// Next morning at 7, the usual "not tonight" answer.
export function minutesUntilMorning(now: Date): number {
  const morning = new Date(now);
  morning.setHours(7, 0, 0, 0);
  if (morning <= now) morning.setDate(morning.getDate() + 1);
  return Math.min(MAX_MINUTES, Math.max(1, Math.round((morning.getTime() - now.getTime()) / 60_000)));
}

// null minutes: until it is turned off.
export const HIDE_CHOICES: HideChoice[] = [
  { key: "15m", label: "15 min", minutes: () => 15 },
  { key: "30m", label: "30 min", minutes: () => 30 },
  { key: "1h", label: "1 hour", minutes: () => 60 },
  { key: "3h", label: "3 hours", minutes: () => 180 },
  { key: "morning", label: "Until 7:00", minutes: minutesUntilMorning },
  { key: "off", label: "Until I turn it off", minutes: () => null },
];

export const hiddenForever = (until: number) => until >= FOREVER;

// "Hidden until 14:35", "Hidden until tomorrow, 07:00" or "Hidden until you turn it off".
export function hiddenLabel(until: number, now = new Date()): string {
  if (hiddenForever(until)) return "Hidden until you turn it off";
  const end = new Date(until);
  const clock = end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (end.toDateString() === now.toDateString()) return `Hidden until ${clock}`;
  if (end.toDateString() === tomorrow.toDateString()) return `Hidden until tomorrow, ${clock}`;
  return `Hidden until ${end.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${clock}`;
}

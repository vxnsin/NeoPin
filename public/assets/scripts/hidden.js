// Invisible: gone from everyone else's map for a while, as in the app's settings. The server
// keeps the time, so it also ends on its own while no page is open.
// Plain functions without the page, so the tests can run this file as it is.

// What the server stores for "until I turn it off": the latest date JavaScript knows.
const HIDDEN_FOREVER = 8_640_000_000_000_000;
const HIDE_MAX_MINUTES = 7 * 24 * 60;

// Next morning at 7, the usual "not tonight" answer. Rounded up, so it never ends before 7:00.
function minutesUntilMorning(now = new Date()) {
  const morning = new Date(now);
  morning.setHours(7, 0, 0, 0);
  if (morning <= now) morning.setDate(morning.getDate() + 1);
  return Math.min(HIDE_MAX_MINUTES, Math.max(1, Math.ceil((morning - now) / 60_000)));
}

// null minutes: until it is turned off.
const HIDE_CHOICES = [
  { label: "15 min", minutes: () => 15 },
  { label: "30 min", minutes: () => 30 },
  { label: "1 hour", minutes: () => 60 },
  { label: "3 hours", minutes: () => 180 },
  { label: "Until 7:00", minutes: minutesUntilMorning },
  { label: "Until I turn it off", minutes: () => null },
];

// "Hidden until 14:35", "Hidden until tomorrow, 07:00" or "Hidden until you turn it off".
function hiddenLabel(until, now = new Date()) {
  if (until >= HIDDEN_FOREVER) return "Hidden until you turn it off";
  const end = new Date(until);
  const clock = end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (end.toDateString() === now.toDateString()) return `Hidden until ${clock}`;
  if (end.toDateString() === tomorrow.toDateString()) return `Hidden until tomorrow, ${clock}`;
  return `Hidden until ${end.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${clock}`;
}

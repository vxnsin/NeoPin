const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

// When something happened, as a clock time: "23:14" today, "Mon 23:14" within the week,
// "27 Oct 23:14" before that. For readings that are old enough to need a time.
export function clockTime(timestamp: string | null | undefined, now = Date.now()): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const stamp = date.getTime();
  if (Number.isNaN(stamp)) return "";
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const age = now - stamp;
  const today = new Date(now);
  if (age < 86_400_000 && date.getDate() === today.getDate()) return time;
  if (age < 6 * 86_400_000) return `${WEEKDAYS[date.getDay()]} ${time}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

export function timeAgo(timestamp: string | null | undefined): string {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

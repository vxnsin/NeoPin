import type { PlaceKind, Review, ReviewDay, ReviewLine, ReviewPeriod, ReviewPlace, TransitKind, TripMode } from "@/lib/api";
import { PLACE_LABELS, TRANSIT_LABELS, dayKey, formatDistance, formatDuration, parseDay, shiftDay, type RouteSegment } from "@/lib/timeline";

// The weekly and monthly review: which period is shown, how it reads, and what a notification or a
// push about one opens. Kept free of native modules so it can be tested.

export const PERIODS: readonly ReviewPeriod[] = ["week", "month"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(value: unknown): value is string {
  // "2026-02-30" would roll over into March, so the day has to come back as it went in.
  return typeof value === "string" && DAY_PATTERN.test(value) && dayKey(parseDay(value)) === value;
}

export function isPeriod(value: unknown): value is ReviewPeriod {
  return value === "week" || value === "month";
}

// Weeks run Monday to Sunday, as on the server.
function weekStart(key: string): string {
  const date = parseDay(key);
  return shiftDay(key, -((date.getDay() + 6) % 7));
}

function monthStart(key: string, delta = 0): string {
  const date = parseDay(key);
  return dayKey(new Date(date.getFullYear(), date.getMonth() + delta, 1));
}

// The first and the last day of the week or month that holds `key`.
export function periodRange(period: ReviewPeriod, key: string): { from: string; to: string } {
  if (period === "week") {
    const from = weekStart(key);
    return { from, to: shiftDay(from, 6) };
  }
  const date = parseDay(key);
  return { from: monthStart(key), to: dayKey(new Date(date.getFullYear(), date.getMonth() + 1, 0)) };
}

// The first day of the period `delta` steps away.
export function shiftPeriod(period: ReviewPeriod, key: string, delta: number): string {
  return period === "week" ? shiftDay(weekStart(key), 7 * delta) : monthStart(key, delta);
}

// What opens without a date: the last finished week or month, like the server's default.
export function lastCompleted(period: ReviewPeriod, now = new Date()): string {
  return shiftPeriod(period, dayKey(now), -1);
}

// Forward stops at the running period; the future has nothing to show.
export function canGoForward(period: ReviewPeriod, key: string, now = new Date()): boolean {
  return shiftPeriod(period, key, 1) <= dayKey(now);
}

// Switching between week and month keeps the place in time: the week of the month's first day would
// jump back, so it takes the month's last week that has begun, and a week turns into its month.
export function switchPeriod(from: ReviewPeriod, to: ReviewPeriod, key: string, now = new Date()): string {
  if (from === to) return key;
  if (to === "month") return monthStart(key);
  const range = periodRange("month", key);
  const today = dayKey(now);
  return weekStart(range.to < today ? range.to : today);
}

function shortDay(key: string): string {
  const date = parseDay(key);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

// "20 – 26 Oct", "27 Oct – 2 Nov", with the year once it is not this one.
export function rangeLabel(from: string, to: string, now = new Date()): string {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a.getFullYear() !== b.getFullYear()) return `${shortDay(from)} ${a.getFullYear()} – ${shortDay(to)} ${b.getFullYear()}`;
  const year = b.getFullYear() === now.getFullYear() ? "" : ` ${b.getFullYear()}`;
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} – ${shortDay(to)}${year}`;
  return `${shortDay(from)} – ${shortDay(to)}${year}`;
}

// The line over the numbers: "Last week" with its days, or "October" with "This month".
export function periodHeading(period: ReviewPeriod, key: string, now = new Date()): { title: string; detail: string } {
  const { from, to } = periodRange(period, key);
  const current = periodRange(period, dayKey(now)).from;
  const previous = shiftPeriod(period, current, -1);
  if (period === "week") {
    const title = from === current ? "This week" : from === previous ? "Last week" : rangeLabel(from, to, now);
    return { title, detail: title === rangeLabel(from, to, now) ? "Week" : rangeLabel(from, to, now) };
  }
  const date = parseDay(from);
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  const detail = from === current ? "This month" : from === previous ? "Last month" : "Month";
  return { title: `${MONTH_NAMES[date.getMonth()]}${year}`, detail };
}

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const count = (value: unknown): number => Math.round(finite(value));
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const MODES: readonly TripMode[] = ["walking", "cycling", "driving", "transit"];
const TRANSIT_KINDS = Object.keys(TRANSIT_LABELS) as TransitKind[];
const PLACE_KINDS = Object.keys(PLACE_LABELS) as PlaceKind[];

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];

// The server's answer, with anything missing or odd turned into nothing rather than a crash on the
// screen. A newer server may send more; that stays out.
export function readReview(raw: unknown, period: ReviewPeriod, date: string): Review {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fallback = periodRange(period, date);
  const from = isDayKey(r.from) ? r.from : fallback.from;
  const to = isDayKey(r.to) ? r.to : fallback.to;
  const byModeRaw = (r.byMode && typeof r.byMode === "object" ? r.byMode : {}) as Record<string, any>;
  const byMode = Object.fromEntries(
    MODES.map((mode) => [mode, { km: finite(byModeRaw[mode]?.km), minutes: finite(byModeRaw[mode]?.minutes) }])
  ) as Review["byMode"];
  const transit: ReviewLine[] = list(r.transit)
    .filter((t) => text(t.line))
    .map((t) => ({
      kind: TRANSIT_KINDS.includes(t.kind as TransitKind) ? (t.kind as TransitKind) : "bus",
      line: text(t.line),
      color: isColor(t.color) ? t.color : null,
      rides: count(t.rides),
    }));
  const topPlaces: ReviewPlace[] = list(r.topPlaces)
    .slice(0, 5)
    .map((p) => {
      const kind = PLACE_KINDS.includes(p.kind as PlaceKind) ? (p.kind as PlaceKind) : "place";
      return { name: text(p.name) || PLACE_LABELS[kind], kind, visits: count(p.visits), minutes: finite(p.minutes) };
    });
  const days: ReviewDay[] = list(r.days)
    .filter((d) => isDayKey(d.date))
    .map((d) => ({ date: d.date as string, km: finite(d.km), movingMinutes: finite(d.movingMinutes) }));
  const path = (Array.isArray(r.path) ? r.path : []).filter(
    (p): p is [number, number] =>
      Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180
  );
  const prev = r.previous && typeof r.previous === "object" ? (r.previous as Record<string, unknown>) : null;
  const distanceKm = finite(r.distanceKm);
  const trips = count(r.trips);
  return {
    period: isPeriod(r.period) ? r.period : period,
    from,
    to,
    distanceKm,
    movingMinutes: finite(r.movingMinutes),
    trips,
    stops: count(r.stops),
    byMode,
    transit,
    topPlaces,
    newPlaces: count(r.newPlaces),
    days,
    path: path.map((p) => [p[0], p[1]]),
    previous: prev ? { distanceKm: finite(prev.distanceKm), movingMinutes: finite(prev.movingMinutes) } : null,
    empty: r.empty === true || (r.empty === undefined && distanceKm === 0 && trips === 0 && days.every((d) => d.km === 0)),
  };
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

// The big number on top: "84" "km", "8.4" "km", "450" "m".
export function distanceParts(km: number): { value: string; unit: string } {
  const [value, unit] = formatDistance(km * 1000).split(" ");
  return { value, unit };
}

export function formatKm(km: number): string {
  return formatDistance(km * 1000);
}

// "6 h 20 min"; nothing on the move is "0 min", not "< 1 min".
export function formatMinutes(minutes: number): string {
  return minutes > 0 ? formatDuration(minutes * 60_000) : "0 min";
}

export type Change = { percent: number; direction: "up" | "down" | "same" };

// Against the period before; nothing to compare with (no data then) is null.
export function compare(current: number, previous: number | null | undefined): Change | null {
  if (!previous || previous <= 0) return null;
  const percent = Math.round(((current - previous) / previous) * 100);
  return { percent: Math.abs(percent), direction: percent > 0 ? "up" : percent < 0 ? "down" : "same" };
}

// "12% more than the week before".
export function changeText(change: Change, period: ReviewPeriod): string {
  const before = `the ${period} before`;
  if (change.direction === "same") return `Same as ${before}`;
  return `${change.percent}% ${change.direction === "up" ? "more" : "less"} than ${before}`;
}

export type ModeShare = { mode: TripMode; km: number; minutes: number; share: number };

// Each way of getting around with its part of the distance; by time when nothing was measured in km.
// Biggest first, ways not used left out.
export function modeShares(byMode: Review["byMode"]): ModeShare[] {
  const rows = MODES.map((mode) => ({ mode, km: byMode[mode]?.km ?? 0, minutes: byMode[mode]?.minutes ?? 0 })).filter(
    (row) => row.km > 0 || row.minutes > 0
  );
  const totalKm = rows.reduce((sum, row) => sum + row.km, 0);
  const totalMin = rows.reduce((sum, row) => sum + row.minutes, 0);
  return rows
    .map((row) => ({ ...row, share: totalKm > 0 ? row.km / totalKm : totalMin > 0 ? row.minutes / totalMin : 0 }))
    .sort((a, b) => b.share - a.share);
}

export function shareText(share: number): string {
  if (share <= 0) return "0%";
  const percent = Math.round(share * 100);
  return percent < 1 ? "<1%" : `${percent}%`;
}

export type DayBar = { date: string; km: number; movingMinutes: number; ratio: number; label: string };

// One bar per day of the period, also for days the server left out. A week is labelled with the
// weekday, a month with every seventh day.
export function dayBars(review: Pick<Review, "period" | "from" | "to" | "days">): DayBar[] {
  const byDate = new Map(review.days.map((d) => [d.date, d]));
  const bars: DayBar[] = [];
  for (let key = review.from, i = 0; key <= review.to && i < 31; key = shiftDay(key, 1), i++) {
    const day = byDate.get(key);
    const date = parseDay(key);
    const label = review.period === "week" ? WEEKDAY_LETTERS[date.getDay()] : (date.getDate() - 1) % 7 === 0 ? String(date.getDate()) : "";
    bars.push({ date: key, km: day?.km ?? 0, movingMinutes: day?.movingMinutes ?? 0, ratio: 0, label });
  }
  const max = Math.max(0, ...bars.map((b) => b.km));
  return bars.map((b) => ({ ...b, ratio: max > 0 ? b.km / max : 0 }));
}

// Feeds rarely bring a text colour for the line, so the badge picks one that reads on it.
export function badgeTextColor(color: string | null): string | null {
  if (!color || !isColor(color)) return null;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.6 ? "#0f172a" : "#ffffff";
}

// "12 rides", "1 ride".
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The whole period as one line on the small map, drawn like a trip of the timeline.
export function reviewRoute(path: [number, number][], color: string): RouteSegment[] {
  return path.length >= 2 ? [{ type: "trip", index: 0, mode: "walking", color, path }] : [];
}

// "Your week: 84 km" in the notifications list, the push says the same.
export function reviewTitle(period: ReviewPeriod, distanceKm: number): string {
  return `Your ${period}: ${formatKm(finite(distanceKm))}`;
}

// What a review notification or push opens: the period and a day in it. Without a usable day the
// review opens at the last finished period.
export type ReviewTarget = { period: ReviewPeriod; date: string | null };

export function reviewTarget(data: unknown): ReviewTarget {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const period = isPeriod(d.period) ? d.period : "week";
  const date = isDayKey(d.from) ? d.from : isDayKey(d.date) ? d.date : isDayKey(d.to) ? d.to : null;
  return { period, date };
}

// Route params arrive as strings or lists of strings.
export function targetFromParams(params: { period?: string | string[]; date?: string | string[] }, now = new Date()): { period: ReviewPeriod; date: string } {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const period = isPeriod(first(params.period)) ? (first(params.period) as ReviewPeriod) : "week";
  const raw = first(params.date);
  const date = isDayKey(raw) && raw <= dayKey(now) ? raw : lastCompleted(period, now);
  return { period, date: periodRange(period, date).from };
}

// A tapped push asks the map screen to open a review. The screen may not be mounted yet (cold start),
// so the request waits here until it takes it, like a requested sheet.
let pending: ReviewTarget | null = null;
const listeners = new Set<(target: ReviewTarget) => void>();

export function requestReview(target: ReviewTarget) {
  pending = target;
  listeners.forEach((listener) => listener(target));
}

export function takeRequestedReview(): ReviewTarget | null {
  const target = pending;
  pending = null;
  return target;
}

export function onReviewRequest(listener: (target: ReviewTarget) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

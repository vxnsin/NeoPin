import type { PlaceKind, Segment, Trip, TripMode, Visit } from "@/lib/api";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return "< 1 min";
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(ms / HOUR);
  const rest = Math.round((ms - hours * HOUR) / MINUTE);
  if (rest === 60) return `${hours + 1} h`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 1) return "0 m";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

const pad = (n: number) => String(n).padStart(2, "0");

// 24 h clock in the phone's time zone.
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

// Calendar days travel as "2025-06-10" in the phone's time zone.
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDay(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function shiftDay(key: string, delta: number): string {
  const date = parseDay(key);
  date.setDate(date.getDate() + delta);
  return dayKey(date);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayLabel(key: string, now = new Date()): string {
  const today = dayKey(now);
  if (key === today) return "Today";
  if (key === shiftDay(today, -1)) return "Yesterday";
  const date = parseDay(key);
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

export function shortDayLabel(key: string, now = new Date()): string {
  const label = dayLabel(key, now);
  if (label === "Today" || label === "Yesterday") return label;
  const date = parseDay(key);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export const PLACE_LABELS: Record<PlaceKind, string> = {
  home: "Home",
  work: "Work",
  cafe: "Café",
  restaurant: "Restaurant",
  bar: "Bar",
  grocery: "Groceries",
  shop: "Shop",
  station: "Station",
  school: "School",
  health: "Health",
  sport: "Sport",
  park: "Park",
  culture: "Culture",
  hotel: "Hotel",
  worship: "Place of worship",
  fuel: "Fuel",
  building: "Building",
  place: "Place",
};

export const PLACE_ICONS = {
  home: "home",
  work: "work",
  cafe: "local-cafe",
  restaurant: "restaurant",
  bar: "local-bar",
  grocery: "local-grocery-store",
  shop: "shopping-bag",
  station: "train",
  school: "school",
  health: "local-hospital",
  sport: "fitness-center",
  park: "park",
  culture: "museum",
  hotel: "hotel",
  worship: "church",
  fuel: "local-gas-station",
  building: "apartment",
  place: "place",
} as const satisfies Record<PlaceKind, string>;

// "Café Mohr", or "Stop 2" while the place has no name.
export function visitTitle(visit: Visit, number: number | undefined): string {
  return visit.place?.name ?? `Stop ${number ?? ""}`.trim();
}

// "Café · suggested" for a guess, "Café" once confirmed, null without a place.
export function visitKind(visit: Visit): string | null {
  if (!visit.place) return null;
  const label = PLACE_LABELS[visit.place.kind] ?? "Place";
  return visit.place.source === "osm" ? `${label} · suggested` : label;
}

export const MODE_LABELS: Record<TripMode, string> = {
  walking: "Walking",
  cycling: "Cycling",
  driving: "Driving",
};

export const MODE_ICONS: Record<TripMode, "directions-walk" | "directions-bike" | "directions-car"> = {
  walking: "directions-walk",
  cycling: "directions-bike",
  driving: "directions-car",
};

export const MODE_COLORS: Record<TripMode, string> = {
  walking: "#0284c7",
  cycling: "#16a34a",
  driving: "#d3171e",
};

// Visit markers on the map are numbered in the order of the day.
export function visitNumbers(segments: Segment[]): Map<number, number> {
  const numbers = new Map<number, number>();
  let next = 1;
  segments.forEach((segment, index) => {
    if (segment.type === "visit") numbers.set(index, next++);
  });
  return numbers;
}

// What the map page needs to draw a day: trip lines and numbered stops.
export type RouteSegment =
  | { type: "visit"; index: number; number: number; lat: number; lon: number }
  | { type: "trip"; index: number; mode: TripMode; color: string; path: [number, number][] };

export function routeSegments(segments: Segment[]): RouteSegment[] {
  const numbers = visitNumbers(segments);
  const out: RouteSegment[] = [];
  segments.forEach((segment, index) => {
    if (segment.type === "visit") {
      out.push({ type: "visit", index, number: numbers.get(index) ?? 0, lat: segment.lat, lon: segment.lon });
    } else if ((segment as Trip).path?.length >= 2) {
      out.push({ type: "trip", index, mode: segment.mode, color: MODE_COLORS[segment.mode], path: segment.path });
    }
  });
  return out;
}

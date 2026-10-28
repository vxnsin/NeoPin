import {
  MODE_CHOICES,
  MODE_COLORS,
  MODE_ICONS,
  MODE_LABELS,
  TRANSIT_ICONS,
  TRANSIT_LABELS,
  dayKey,
  dayLabel,
  formatClock,
  formatDistance,
  formatDuration,
  routeChange,
  routeSegments,
  shiftDay,
  stillPending,
  transitRow,
  tripColor,
  tripIcon,
  tripTitle,
  visitKind,
  visitNumbers,
  visitTitle,
} from "../lib/timeline";
import type { Segment, TransitKind, Trip, TripMode } from "../lib/api";

test("durations read like a clock face", () => {
  expect(formatDuration(20_000)).toBe("< 1 min");
  expect(formatDuration(5 * 60_000)).toBe("5 min");
  expect(formatDuration(60 * 60_000)).toBe("1 h");
  expect(formatDuration(80 * 60_000)).toBe("1 h 20 min");
  expect(formatDuration(119.7 * 60_000)).toBe("2 h");
  expect(formatDuration(NaN)).toBe("< 1 min");
});

test("distances switch to kilometres at 1 km", () => {
  expect(formatDistance(0)).toBe("0 m");
  expect(formatDistance(849.6)).toBe("850 m");
  expect(formatDistance(3240)).toBe("3.2 km");
  expect(formatDistance(12_400)).toBe("12 km");
});

test("clock times are zero padded", () => {
  expect(formatClock(new Date(2025, 5, 10, 7, 5).getTime())).toBe("07:05");
  expect(formatClock(new Date(2025, 5, 10, 23, 59).getTime())).toBe("23:59");
});

test("days shift across month and year borders", () => {
  expect(shiftDay("2025-03-01", -1)).toBe("2025-02-28");
  expect(shiftDay("2025-12-31", 1)).toBe("2026-01-01");
  expect(dayKey(new Date(2025, 0, 5))).toBe("2025-01-05");
});

test("day labels name today and yesterday", () => {
  const now = new Date(2025, 5, 10, 12);
  expect(dayLabel("2025-06-10", now)).toBe("Today");
  expect(dayLabel("2025-06-09", now)).toBe("Yesterday");
  expect(dayLabel("2025-06-03", now)).toBe("Tue, 3 Jun");
  expect(dayLabel("2024-12-24", now)).toBe("Tue, 24 Dec 2024");
});

const visit = (lat: number): Segment => ({ type: "visit", start: 0, end: 1, durationMs: 1, lat, lon: 2, pointCount: 3 });
const trip = (path: [number, number][]): Segment => ({
  type: "trip",
  start: 0,
  end: 1,
  durationMs: 1,
  distanceM: 5,
  mode: "cycling",
  path,
});

test("the day is asked for again while place names or smoother paths are still coming", () => {
  expect(stillPending({ placesPending: true })).toBe(true);
  expect(stillPending({ pathsPending: true })).toBe(true);
  expect(stillPending({ placesPending: false, pathsPending: false })).toBe(false);
  expect(stillPending({})).toBe(false);
  expect(stillPending(null)).toBe(false);
});

test("a refresh that only smoothed the lines swaps them in place, anything else redraws the day", () => {
  const before = routeSegments([visit(1), trip([[1, 2], [1.5, 2.5], [3, 4]]), visit(3)]);
  expect(routeChange(before, routeSegments([visit(1), trip([[1, 2], [1.5, 2.5], [3, 4]]), visit(3)]))).toBe("none");
  // Same stops, a smoother line between them.
  const smoothed = routeSegments([visit(1), trip([[1, 2], [1.2, 2.1], [1.6, 2.7], [3, 4]]), visit(3)]);
  expect(routeChange(before, smoothed)).toBe("paths");
  // A stop moved, or a segment came or went: the day is drawn anew.
  expect(routeChange(before, routeSegments([visit(1), trip([[1, 2], [3, 4]]), visit(5)]))).toBe("full");
  // Same stops, but the trip is now another mode in another colour: the stop dots follow only on a redraw.
  const recoloured = before.map((s) => (s.type === "trip" ? { ...s, mode: "driving" as const, color: "#123456" } : s));
  expect(routeChange(before, recoloured)).toBe("full");
  expect(routeChange(before, routeSegments([visit(1)]))).toBe("full");
  expect(routeChange([], before)).toBe("full");
});

test("stops are numbered in order and trips keep their index", () => {
  const segments = [visit(1), trip([[1, 2], [3, 4]]), visit(3)];
  expect([...visitNumbers(segments)]).toEqual([[0, 1], [2, 2]]);
  const route = routeSegments(segments);
  expect(route.map((s) => [s.type, s.index])).toEqual([["visit", 0], ["trip", 1], ["visit", 2]]);
  expect(route[2]).toMatchObject({ number: 2, lat: 3, lon: 2 });
  expect(route[1]).toMatchObject({ color: "#16a34a" });
});

test("a trip without a line is not drawn", () => {
  expect(routeSegments([trip([[1, 2]])])).toEqual([]);
});

// A bus ride as the server sends it: the line, where it was boarded and left, the line's colours.
const ride: Trip = {
  type: "trip",
  start: new Date(2025, 5, 10, 8, 12).getTime(),
  end: new Date(2025, 5, 10, 8, 31).getTime(),
  durationMs: 19 * 60_000,
  distanceM: 4100,
  mode: "transit",
  path: [[49.79, 9.95], [49.795, 9.94], [49.8, 9.93]],
  transit: {
    kind: "bus",
    line: "10",
    headsign: "Hauptbahnhof",
    color: "#e30613",
    textColor: "#ffffff",
    agency: "WVV",
    from: { name: "Sanderring", lat: 49.79, lon: 9.95 },
    to: { name: "Hauptbahnhof", lat: 49.8, lon: 9.93 },
    source: "gtfs",
  },
};

test("a ride shows its line badge, the vehicle and the stops", () => {
  expect(transitRow(ride)).toEqual({ badge: "10", label: "Bus", stops: "Sanderring → Hauptbahnhof", color: "#e30613", textColor: "#ffffff" });
  expect(tripTitle(ride)).toBe("Bus 10, Sanderring → Hauptbahnhof");
  expect(tripIcon(ride)).toBe("directions-bus");
  expect(tripColor(ride)).toBe("#e30613");
});

test("a ride without a matched line falls back to the transit mode", () => {
  const plain: Trip = { ...ride, transit: null };
  expect(transitRow(plain)).toBeNull();
  expect(tripTitle(plain)).toBe("Transit");
  expect(tripIcon(plain)).toBe("directions-transit");
  expect(tripColor(plain)).toBe(MODE_COLORS.transit);
  // A line without colours of its own takes the mode's.
  expect(tripColor({ ...ride, transit: { ...ride.transit!, color: null } })).toBe(MODE_COLORS.transit);
});

test("on the map a ride is drawn in its line colour with its two stops", () => {
  const [route] = routeSegments([ride]);
  expect(route).toMatchObject({ type: "trip", color: "#e30613", stops: [{ lat: 49.79, lon: 9.95 }, { lat: 49.8, lon: 9.93 }] });
  expect(routeSegments([trip([[1, 2], [3, 4]])])[0]).not.toHaveProperty("stops");
});

test("every trip mode and transit kind has a label, an icon and a colour", () => {
  const modes: TripMode[] = ["walking", "cycling", "driving", "transit"];
  for (const mode of modes) {
    expect(MODE_LABELS[mode]).toBeTruthy();
    expect(MODE_ICONS[mode]).toBeTruthy();
    expect(MODE_COLORS[mode]).toMatch(/^#/);
  }
  expect(Object.keys(MODE_LABELS).sort()).toEqual([...modes].sort());
  expect(MODE_CHOICES).toEqual([...modes, "auto"]);
  const kinds: TransitKind[] = ["bus", "tram", "subway", "train", "ferry"];
  for (const kind of kinds) {
    expect(TRANSIT_LABELS[kind]).toBeTruthy();
    expect(TRANSIT_ICONS[kind]).toBeTruthy();
  }
});

test("a password change is checked before it is sent", () => {
  const { passwordProblem } = require("../lib/password");
  expect(passwordProblem("", "newpassword", "newpassword")).toBeDefined();
  expect(passwordProblem("old", "short", "short")).toMatch(/at least 8/);
  expect(passwordProblem("old", "newpassword", "different1")).toMatch(/do not match/);
  expect(passwordProblem("samepassword", "samepassword", "samepassword")).toBeDefined();
  expect(passwordProblem("old", "newpassword", "newpassword")).toBeUndefined();
});

test("a visit is titled by its place, or numbered while it has none", () => {
  const visit = { type: "visit", start: 0, end: 1, durationMs: 1, lat: 49.79, lon: 9.95, pointCount: 3 } as const;
  expect(visitTitle(visit, 2)).toBe("Stop 2");
  expect(visitKind(visit)).toBeNull();
  const guessed = { ...visit, place: { id: null, name: "Café Mohr", kind: "cafe", source: "osm", osmId: "node/1" } as const };
  expect(visitTitle(guessed, 2)).toBe("Café Mohr");
  expect(visitKind(guessed)).toBe("Café · suggested");
  expect(visitKind({ ...guessed, place: { ...guessed.place, id: 4, source: "own" } })).toBe("Café");
});

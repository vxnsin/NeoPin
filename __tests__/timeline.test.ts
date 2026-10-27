import {
  dayKey,
  dayLabel,
  formatClock,
  formatDistance,
  formatDuration,
  routeSegments,
  shiftDay,
  visitKind,
  visitNumbers,
  visitTitle,
} from "../lib/timeline";
import type { Segment } from "../lib/api";

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

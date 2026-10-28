import { batteryOf } from "../lib/devices";
import { clockTime } from "../lib/time";

// Local times, so the expectations do not depend on the machine's zone.
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).toISOString();
const now = new Date(2026, 9, 28, 22, 0).getTime(); // Wednesday

test("a reading from today is just the clock time", () => {
  expect(clockTime(at(2026, 10, 28, 9, 5), now)).toBe("09:05");
});

test("a reading from this week carries the weekday", () => {
  expect(clockTime(at(2026, 10, 27, 23, 14), now)).toBe("Tue 23:14");
  expect(clockTime(at(2026, 10, 23, 7, 30), now)).toBe("Fri 07:30");
});

test("older readings carry the date", () => {
  expect(clockTime(at(2026, 10, 19, 18, 0), now)).toBe("19 Oct 18:00");
  expect(clockTime(at(2025, 12, 31, 23, 59), now)).toBe("31 Dec 23:59");
});

test("no time or a broken one gives nothing", () => {
  expect(clockTime(null, now)).toBe("");
  expect(clockTime(undefined, now)).toBe("");
  expect(clockTime("yesterday", now)).toBe("");
});

test("an offline device keeps its last battery reading", () => {
  const battery = { level: 12, charging: false, updatedAt: at(2026, 10, 28, 21, 14) };
  expect(batteryOf({ battery })).toEqual(battery);
  expect(batteryOf({ battery: null })).toBeNull();
  expect(batteryOf({})).toBeNull();
});

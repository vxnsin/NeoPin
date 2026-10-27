import { HIDE_CHOICES, hiddenForever, hiddenLabel, minutesUntilMorning } from "../lib/hidden";

test("until morning means the next 7:00, also after midnight", () => {
  expect(minutesUntilMorning(new Date(2026, 9, 27, 22, 30))).toBe(8 * 60 + 30);
  expect(minutesUntilMorning(new Date(2026, 9, 28, 1, 0))).toBe(6 * 60);
  expect(minutesUntilMorning(new Date(2026, 9, 28, 7, 0))).toBe(24 * 60);
});

test("the choices go from a quarter of an hour to until turned off", () => {
  const now = new Date(2026, 9, 27, 12, 0);
  expect(HIDE_CHOICES.map((c) => c.minutes(now))).toEqual([15, 30, 60, 180, 19 * 60, null]);
});

// The clock reads the way the phone shows times (14:35 or 02:35 PM), so the test asks the same way.
const clock = (date: Date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

test("rounding up, until morning never ends before 7:00", () => {
  expect(minutesUntilMorning(new Date(2026, 9, 27, 12, 0, 31))).toBe(19 * 60);
});

test("the label says until when, and until turned off for the server's latest date", () => {
  const now = new Date(2026, 9, 27, 12, 0);
  const later = new Date(2026, 9, 27, 14, 35);
  const morning = new Date(2026, 9, 28, 7, 0);
  expect(hiddenLabel(later.getTime(), now)).toBe(`Hidden until ${clock(later)}`);
  expect(hiddenLabel(morning.getTime(), now)).toBe(`Hidden until tomorrow, ${clock(morning)}`);
  expect(hiddenForever(8_640_000_000_000_000)).toBe(true);
  expect(hiddenLabel(8_640_000_000_000_000, now)).toBe("Hidden until you turn it off");
});

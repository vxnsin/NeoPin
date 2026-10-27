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

test("the label says until when, and until turned off for the server's latest date", () => {
  const now = new Date(2026, 9, 27, 12, 0);
  expect(hiddenLabel(new Date(2026, 9, 27, 14, 35).getTime(), now)).toMatch(/^Hidden until 14[:.]35$/);
  expect(hiddenLabel(new Date(2026, 9, 28, 7, 0).getTime(), now)).toMatch(/^Hidden until tomorrow, 0?7[:.]00$/);
  expect(hiddenForever(8_640_000_000_000_000)).toBe(true);
  expect(hiddenLabel(8_640_000_000_000_000, now)).toBe("Hidden until you turn it off");
});

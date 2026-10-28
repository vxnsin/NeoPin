import { OVERSHOOT, clampDrag, panelSnaps, restAfterDrag } from "../lib/sheetSnap";

const snaps = panelSnaps(800, 40, 20);

test("four rests: the header strip, a third, a bit over half, and almost the whole screen", () => {
  expect(snaps).toEqual({ peek: 98, low: 240, mid: 440, high: 736 });
  expect(panelSnaps(800, 40).peek).toBe(78);
});

test("let go slowly: the nearest rest wins", () => {
  expect(restAfterDrag(150, 0, snaps)).toBe(98);
  expect(restAfterDrag(300, 0, snaps)).toBe(240);
  expect(restAfterDrag(400, 100, snaps)).toBe(440);
  expect(restAfterDrag(600, -100, snaps)).toBe(736);
});

test("a flick moves one rest in its direction", () => {
  // Down from the top, barely moved: still one down.
  expect(restAfterDrag(730, 900, snaps)).toBe(440);
  expect(restAfterDrag(430, 900, snaps)).toBe(240);
  expect(restAfterDrag(240, 900, snaps)).toBe(98);
  // Up from the bottom.
  expect(restAfterDrag(100, -900, snaps)).toBe(240);
  expect(restAfterDrag(250, -900, snaps)).toBe(440);
  expect(restAfterDrag(450, -900, snaps)).toBe(736);
  expect(restAfterDrag(736, -900, snaps)).toBe(736);
});

test("dragging down never closes the panel, it stops at the header strip", () => {
  expect(restAfterDrag(20, 0, snaps)).toBe(98);
  expect(restAfterDrag(98, 900, snaps)).toBe(98);
  expect(restAfterDrag(60, 900, snaps)).toBe(98);
});

test("the finger cannot drag the panel off the screen", () => {
  expect(clampDrag(2000, snaps)).toBe(736);
  expect(clampDrag(-50, snaps)).toBe(98 - OVERSHOOT);
  expect(clampDrag(500, snaps)).toBe(500);
});

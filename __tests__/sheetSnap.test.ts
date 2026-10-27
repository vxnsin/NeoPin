import { CLOSE_PULL, clampDrag, panelSnaps, restAfterDrag } from "../lib/sheetSnap";

const snaps = panelSnaps(800, 40);

test("three rests: a third, a bit over half, and almost the whole screen", () => {
  expect(snaps).toEqual({ low: 240, mid: 440, high: 736 });
});

test("let go slowly: the nearest rest wins", () => {
  expect(restAfterDrag(300, 0, snaps)).toBe(240);
  expect(restAfterDrag(400, 100, snaps)).toBe(440);
  expect(restAfterDrag(600, -100, snaps)).toBe(736);
});

test("a flick moves one rest in its direction", () => {
  // Down from the top, barely moved: still one down.
  expect(restAfterDrag(730, 900, snaps)).toBe(440);
  expect(restAfterDrag(430, 900, snaps)).toBe(240);
  // Up from the bottom.
  expect(restAfterDrag(250, -900, snaps)).toBe(440);
  expect(restAfterDrag(450, -900, snaps)).toBe(736);
  expect(restAfterDrag(736, -900, snaps)).toBe(736);
});

test("pulled down past the lowest rest, or flicked down from it, the panel closes", () => {
  expect(restAfterDrag(240 - CLOSE_PULL - 1, 0, snaps)).toBeNull();
  expect(restAfterDrag(240 - CLOSE_PULL + 1, 0, snaps)).toBe(240);
  expect(restAfterDrag(240, 900, snaps)).toBeNull();
  expect(restAfterDrag(230, 900, snaps)).toBeNull();
});

test("the finger cannot drag the panel off the screen", () => {
  expect(clampDrag(2000, snaps)).toBe(736);
  expect(clampDrag(-50, snaps)).toBe(240 - CLOSE_PULL - 40);
  expect(clampDrag(500, snaps)).toBe(500);
});

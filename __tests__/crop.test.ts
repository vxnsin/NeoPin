import { MAX_ZOOM, baseScale, clampView, cropRect } from "../lib/crop";

const FRAME = 300;

test("at zoom 1 the frame shows the centred square of the photo", () => {
  expect(cropRect(3000, 2000, FRAME, { zoom: 1, x: 0, y: 0 })).toEqual({ originX: 500, originY: 0, width: 2000, height: 2000 });
  expect(cropRect(2000, 3000, FRAME, { zoom: 1, x: 0, y: 0 })).toEqual({ originX: 0, originY: 500, width: 2000, height: 2000 });
});

test("zooming in shrinks the crop around the centre", () => {
  const rect = cropRect(2000, 2000, FRAME, { zoom: 2, x: 0, y: 0 });
  expect(rect).toEqual({ originX: 500, originY: 500, width: 1000, height: 1000 });
});

test("dragging the photo right shows more of its left side", () => {
  // 2000 px photo at zoom 2: 1 image px is 0.3 screen px, 30 screen px are 100 image px.
  const rect = cropRect(2000, 2000, FRAME, { zoom: 2, x: 30, y: 0 });
  expect(rect.originX).toBe(400);
  expect(rect.originY).toBe(500);
});

test("the photo cannot be dragged off the frame", () => {
  const view = clampView(3000, 2000, FRAME, { zoom: 1, x: 999, y: -999 });
  // Wider than tall: free to move sideways by half the surplus, not vertically.
  expect(view.y).toBe(0);
  expect(view.x).toBeCloseTo((3000 * baseScale(3000, 2000, FRAME) - FRAME) / 2);
  const rect = cropRect(3000, 2000, FRAME, { zoom: 1, x: 999, y: 0 });
  expect(rect.originX).toBe(0);
});

test("zoom is limited and the rectangle always stays inside the photo", () => {
  expect(clampView(1000, 1000, FRAME, { zoom: 99, x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
  expect(clampView(1000, 1000, FRAME, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(1);
  for (const x of [-500, 0, 500]) {
    for (const zoom of [1, 3, 99]) {
      const r = cropRect(1234, 987, FRAME, { zoom, x, y: x });
      expect(r.originX).toBeGreaterThanOrEqual(0);
      expect(r.originY).toBeGreaterThanOrEqual(0);
      expect(r.originX + r.width).toBeLessThanOrEqual(1234);
      expect(r.originY + r.height).toBeLessThanOrEqual(987);
      expect(r.width).toBe(r.height);
    }
  }
});

import {
  climbLabel,
  climbText,
  deviceAltitude,
  fixAltitude,
  formatAltitude,
  profileBars,
  readAltitude,
  readClimb,
  readHighest,
  readProfile,
  sampleProfile,
  type ProfilePoint,
} from "../lib/altitude";

describe("the height a fix carries", () => {
  test("whole metres, with the accuracy when the GPS knows it", () => {
    expect(fixAltitude(412.6, 3.5)).toEqual({ altitude: 413, altitudeAccuracy: 4 });
    expect(fixAltitude(-12.2, null)).toEqual({ altitude: -12 });
  });

  test("unknown or impossible heights stay out", () => {
    expect(fixAltitude(null, 3)).toEqual({});
    expect(fixAltitude(undefined, undefined)).toEqual({});
    expect(fixAltitude(NaN, 3)).toEqual({});
    expect(fixAltitude(25_000, 3)).toEqual({});
    expect(fixAltitude(300, -1)).toEqual({ altitude: 300 });
    expect(fixAltitude(300, 5000)).toEqual({ altitude: 300 });
  });
});

describe("reading heights from the server", () => {
  test("a number is rounded, anything else is nothing", () => {
    expect(readAltitude(411.6)).toBe(412);
    expect(readAltitude(0)).toBe(0);
    expect(readAltitude(null)).toBeNull();
    expect(readAltitude(undefined)).toBeNull();
    expect(readAltitude("412")).toBeNull();
    expect(readAltitude(Infinity)).toBeNull();
    expect(readAltitude(99_999)).toBeNull();
  });

  test("a device's height comes from its position, older servers send none", () => {
    expect(deviceAltitude({ position: { altitude: 412.2 } })).toBe(412);
    expect(deviceAltitude({ position: { altitude: null } })).toBeNull();
    expect(deviceAltitude({ position: {} })).toBeNull();
    expect(deviceAltitude({ position: null })).toBeNull();
  });

  test("a climb is never negative", () => {
    expect(readClimb(84.6)).toBe(85);
    expect(readClimb(0)).toBe(0);
    expect(readClimb(-3)).toBeNull();
    expect(readClimb(undefined)).toBeNull();
  });

  test("the highest point keeps its name when it has one", () => {
    expect(readHighest({ altitudeM: 612.4, name: " Festung " })).toEqual({ altitudeM: 612, name: "Festung" });
    expect(readHighest({ altitudeM: 612, name: null })).toEqual({ altitudeM: 612, name: null });
    expect(readHighest({ name: "Festung" })).toBeNull();
    expect(readHighest(null)).toBeNull();
    expect(readHighest(612)).toBeNull();
  });
});

describe("how heights read", () => {
  test("metres with a thousands separator", () => {
    expect(formatAltitude(412.4)).toBe("412 m");
    expect(formatAltitude(1240)).toBe("1,240 m");
    expect(formatAltitude(0)).toBe("0 m");
    expect(formatAltitude(-1500)).toBe("-1,500 m");
  });

  test("up and down under a trip, flat trips show nothing", () => {
    expect(climbText(85, 40)).toBe("↑ 85 m ↓ 40 m");
    expect(climbText(85, 0)).toBe("↑ 85 m");
    expect(climbText(0.2, 12)).toBe("↓ 12 m");
    expect(climbText(0, 0)).toBeNull();
    expect(climbText(undefined, undefined)).toBeNull();
    expect(climbLabel(85, 40)).toBe("85 metres up, 40 metres down");
    expect(climbLabel(null, null)).toBeNull();
  });
});

describe("the height profile", () => {
  test("broken pairs are left out and the rest is in order of the way", () => {
    expect(readProfile([[100, 420], [0, 400.4], ["x", 3], [50], [20, null], [-1, 300], [30, 410]])).toEqual([
      [0, 400],
      [30, 410],
      [100, 420],
    ]);
    expect(readProfile(undefined)).toEqual([]);
    expect(readProfile("nope")).toEqual([]);
  });

  test("sampling spreads the columns evenly along the distance", () => {
    const points: ProfilePoint[] = [
      [0, 100],
      [100, 200],
      [400, 200],
    ];
    expect(sampleProfile(points, 5)).toEqual([100, 200, 200, 200, 200]);
    expect(sampleProfile(points, 9)[1]).toBe(150);
    expect(sampleProfile(points, 1)).toEqual([200]);
    expect(sampleProfile([[0, 100]], 5)).toEqual([]);
    expect(sampleProfile([[10, 100], [10, 200]], 5)).toEqual([]);
  });

  test("sampling a long profile down keeps its shape", () => {
    const points: ProfilePoint[] = Array.from({ length: 200 }, (_, i) => [i * 10, 300 + Math.round(50 * Math.sin(i / 20))]);
    const heights = sampleProfile(points, 40);
    expect(heights).toHaveLength(40);
    expect(heights[0]).toBe(300);
    expect(Math.max(...heights)).toBeLessThanOrEqual(350);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(250);
  });

  test("bars run from a sliver at the lowest point to full at the highest", () => {
    const bars = profileBars(
      [
        [0, 300],
        [500, 400],
        [1000, 300],
      ],
      3
    )!;
    expect(bars.lowM).toBe(300);
    expect(bars.highM).toBe(400);
    expect(bars.ratios[0]).toBeCloseTo(0.12);
    expect(bars.ratios[1]).toBeCloseTo(1);
    expect(bars.ratios[2]).toBeCloseTo(0.12);
  });

  test("a few metres up and down stay flat", () => {
    const bars = profileBars(
      [
        [0, 200],
        [1000, 204],
      ],
      2
    )!;
    expect(bars.ratios[1] - bars.ratios[0]).toBeLessThan(0.15);
    bars.ratios.forEach((r) => {
      expect(r).toBeGreaterThan(0.4);
      expect(r).toBeLessThan(0.7);
    });
  });

  test("nothing to draw without a profile", () => {
    expect(profileBars([], 40)).toBeNull();
    expect(profileBars([[0, 300]], 40)).toBeNull();
  });
});

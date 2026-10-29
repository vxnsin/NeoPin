import {
  badgeTextColor,
  canGoForward,
  changeText,
  compare,
  dayBars,
  distanceParts,
  formatMinutes,
  lastCompleted,
  modeShares,
  onReviewRequest,
  periodHeading,
  periodRange,
  rangeLabel,
  readReview,
  requestReview,
  reviewRoute,
  reviewTarget,
  reviewTitle,
  shareText,
  shiftPeriod,
  switchPeriod,
  takeRequestedReview,
  targetFromParams,
} from "../lib/review";

// Thursday, 29 October 2026.
const now = new Date(2026, 9, 29, 12, 0);

describe("periods", () => {
  test("a week runs Monday to Sunday, a month is the calendar month", () => {
    expect(periodRange("week", "2026-10-29")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(periodRange("week", "2026-10-26")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    // A Sunday still belongs to the week that started on Monday.
    expect(periodRange("week", "2026-11-01")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(periodRange("month", "2026-02-14")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodRange("month", "2028-02-03")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  test("paging moves by whole weeks and months, across years", () => {
    expect(shiftPeriod("week", "2026-10-29", -1)).toBe("2026-10-19");
    expect(shiftPeriod("week", "2026-10-29", 1)).toBe("2026-11-02");
    expect(shiftPeriod("week", "2026-01-01", -1)).toBe("2025-12-22");
    expect(shiftPeriod("month", "2026-01-31", -1)).toBe("2025-12-01");
    expect(shiftPeriod("month", "2026-01-31", 1)).toBe("2026-02-01");
  });

  test("without a date the last finished period opens", () => {
    expect(lastCompleted("week", now)).toBe("2026-10-19");
    expect(lastCompleted("month", now)).toBe("2026-09-01");
  });

  test("forward stops at the running period", () => {
    expect(canGoForward("week", "2026-10-19", now)).toBe(true);
    expect(canGoForward("week", "2026-10-26", now)).toBe(false);
    expect(canGoForward("month", "2026-09-01", now)).toBe(true);
    expect(canGoForward("month", "2026-10-01", now)).toBe(false);
  });

  test("switching between week and month keeps the place in time", () => {
    expect(switchPeriod("week", "month", "2026-09-28", now)).toBe("2026-09-01");
    // A past month turns into its last week, the running month into this week.
    expect(switchPeriod("month", "week", "2026-09-01", now)).toBe("2026-09-28");
    expect(switchPeriod("month", "week", "2026-10-01", now)).toBe("2026-10-26");
    expect(switchPeriod("week", "week", "2026-10-19", now)).toBe("2026-10-19");
  });
});

describe("labels", () => {
  test("ranges name the days once, the year only when it is not this one", () => {
    expect(rangeLabel("2026-10-19", "2026-10-25", now)).toBe("19 – 25 Oct");
    expect(rangeLabel("2026-10-26", "2026-11-01", now)).toBe("26 Oct – 1 Nov");
    expect(rangeLabel("2025-12-29", "2026-01-04", now)).toBe("29 Dec 2025 – 4 Jan 2026");
    expect(rangeLabel("2025-03-03", "2025-03-09", now)).toBe("3 – 9 Mar 2025");
  });

  test("the heading says this or last week, or the month by name", () => {
    expect(periodHeading("week", "2026-10-27", now)).toEqual({ title: "This week", detail: "26 Oct – 1 Nov" });
    expect(periodHeading("week", "2026-10-19", now)).toEqual({ title: "Last week", detail: "19 – 25 Oct" });
    expect(periodHeading("week", "2026-10-05", now)).toEqual({ title: "5 – 11 Oct", detail: "Week" });
    expect(periodHeading("month", "2026-10-01", now)).toEqual({ title: "October", detail: "This month" });
    expect(periodHeading("month", "2026-09-01", now)).toEqual({ title: "September", detail: "Last month" });
    expect(periodHeading("month", "2025-05-01", now)).toEqual({ title: "May 2025", detail: "Month" });
  });

  test("numbers read like in the timeline", () => {
    expect(distanceParts(84.2)).toEqual({ value: "84", unit: "km" });
    expect(distanceParts(8.44)).toEqual({ value: "8.4", unit: "km" });
    expect(distanceParts(0.45)).toEqual({ value: "450", unit: "m" });
    expect(distanceParts(0)).toEqual({ value: "0", unit: "m" });
    expect(formatMinutes(380)).toBe("6 h 20 min");
    expect(formatMinutes(0)).toBe("0 min");
    expect(reviewTitle("week", 84)).toBe("Your week: 84 km");
    expect(reviewTitle("month", 312.4)).toBe("Your month: 312 km");
  });
});

describe("comparison", () => {
  test("against the period before, in whole percent", () => {
    expect(compare(112, 100)).toEqual({ percent: 12, direction: "up" });
    expect(compare(80, 100)).toEqual({ percent: 20, direction: "down" });
    expect(compare(100, 100)).toEqual({ percent: 0, direction: "same" });
    expect(changeText({ percent: 12, direction: "up" }, "week")).toBe("12% more than the week before");
    expect(changeText({ percent: 20, direction: "down" }, "month")).toBe("20% less than the month before");
    expect(changeText({ percent: 0, direction: "same" }, "week")).toBe("Same as the week before");
  });

  test("nothing to compare with is no comparison", () => {
    expect(compare(10, null)).toBeNull();
    expect(compare(10, undefined)).toBeNull();
    expect(compare(10, 0)).toBeNull();
  });
});

describe("charts", () => {
  test("mode shares by distance, biggest first, unused ways left out", () => {
    const shares = modeShares({
      walking: { km: 10, minutes: 150 },
      cycling: { km: 0, minutes: 0 },
      driving: { km: 30, minutes: 40 },
      transit: { km: 60, minutes: 90 },
    });
    expect(shares.map((s) => s.mode)).toEqual(["transit", "driving", "walking"]);
    expect(shares.map((s) => shareText(s.share))).toEqual(["60%", "30%", "10%"]);
  });

  test("without any km the shares go by time", () => {
    const shares = modeShares({
      walking: { km: 0, minutes: 30 },
      cycling: { km: 0, minutes: 10 },
      driving: { km: 0, minutes: 0 },
      transit: { km: 0, minutes: 0 },
    });
    expect(shares.map((s) => [s.mode, s.share])).toEqual([
      ["walking", 0.75],
      ["cycling", 0.25],
    ]);
    expect(shareText(0.004)).toBe("<1%");
    expect(shareText(0)).toBe("0%");
  });

  test("one bar per day, also for days the server left out", () => {
    const bars = dayBars({
      period: "week",
      from: "2026-10-19",
      to: "2026-10-25",
      days: [
        { date: "2026-10-20", km: 20, movingMinutes: 60 },
        { date: "2026-10-23", km: 5, movingMinutes: 20 },
      ],
    });
    expect(bars).toHaveLength(7);
    expect(bars.map((b) => b.label).join("")).toBe("MTWTFSS");
    expect(bars[1]).toMatchObject({ date: "2026-10-20", km: 20, ratio: 1 });
    expect(bars[4].ratio).toBe(0.25);
    expect(bars[0]).toMatchObject({ km: 0, ratio: 0 });
  });

  test("a month labels every seventh day and an empty month draws flat", () => {
    const bars = dayBars({ period: "month", from: "2026-10-01", to: "2026-10-31", days: [] });
    expect(bars).toHaveLength(31);
    expect(bars.filter((b) => b.label).map((b) => b.label)).toEqual(["1", "8", "15", "22", "29"]);
    expect(bars.every((b) => b.ratio === 0)).toBe(true);
  });

  test("a line badge without a text colour gets one that reads on it", () => {
    expect(badgeTextColor("#d3171e")).toBe("#ffffff");
    expect(badgeTextColor("#ffd800")).toBe("#0f172a");
    expect(badgeTextColor(null)).toBeNull();
    expect(badgeTextColor("red")).toBeNull();
  });

  test("the period's path becomes one line for the map, a single point none", () => {
    const path: [number, number][] = [
      [49.79, 9.95],
      [49.8, 9.96],
    ];
    expect(reviewRoute(path, "#d3171e")).toEqual([{ type: "trip", index: 0, mode: "walking", color: "#d3171e", path }]);
    expect(reviewRoute([[49.79, 9.95]], "#d3171e")).toEqual([]);
  });
});

describe("reading the answer", () => {
  const full = {
    period: "week",
    from: "2026-10-19",
    to: "2026-10-25",
    distanceKm: 84.2,
    movingMinutes: 380,
    trips: 23,
    stops: 31,
    byMode: { walking: { km: 10, minutes: 150 }, cycling: { km: 4, minutes: 20 }, driving: { km: 30, minutes: 40 }, transit: { km: 40.2, minutes: 170 } },
    transit: [{ kind: "tram", line: "4", color: "#e30613", rides: 6 }],
    topPlaces: [{ name: "Home", kind: "home", visits: 7, minutes: 5000 }],
    newPlaces: 2,
    days: [{ date: "2026-10-19", km: 12, movingMinutes: 50 }],
    path: [
      [49.79, 9.95],
      [49.8, 9.96],
    ],
    previous: { distanceKm: 70, movingMinutes: 300 },
    empty: false,
  };

  test("a full answer comes through as it is", () => {
    expect(readReview(full, "week", "2026-10-19")).toEqual(full);
  });

  test("missing or odd fields become nothing, never a crash", () => {
    const review = readReview(
      {
        distanceKm: "x",
        byMode: { walking: { km: -3 } },
        transit: [{ kind: "zeppelin", line: "Z1", color: "pink", rides: 2.4 }, { line: "" }, null],
        topPlaces: [{ kind: "spaceport", visits: 1 }, ...Array(6).fill({ name: "Café", kind: "cafe" })],
        days: [{ date: "yesterday", km: 3 }],
        path: [[49, 9], [200, 9], "x", [49.1, 9.1, 300]],
        previous: null,
      },
      "month",
      "2026-09-14"
    );
    expect(review).toMatchObject({ period: "month", from: "2026-09-01", to: "2026-09-30", distanceKm: 0, trips: 0, days: [], previous: null, empty: true });
    expect(review.byMode.walking).toEqual({ km: 0, minutes: 0 });
    expect(review.byMode.transit).toEqual({ km: 0, minutes: 0 });
    expect(review.transit).toEqual([{ kind: "bus", line: "Z1", color: null, rides: 2 }]);
    expect(review.topPlaces).toHaveLength(5);
    expect(review.topPlaces[0]).toEqual({ name: "Place", kind: "place", visits: 1, minutes: 0 });
    expect(review.path).toEqual([
      [49, 9],
      [49.1, 9.1],
    ]);
    expect(readReview(null, "week", "2026-10-19").empty).toBe(true);
  });

  test("the server's empty flag wins", () => {
    expect(readReview({ ...full, empty: true }, "week", "2026-10-19").empty).toBe(true);
  });
});

describe("opening a review", () => {
  test("a notification or push names the period and its first day", () => {
    expect(reviewTarget({ period: "month", from: "2026-09-01", to: "2026-09-30", distanceKm: "312" })).toEqual({ period: "month", date: "2026-09-01" });
    expect(reviewTarget({ period: "week", to: "2026-10-25" })).toEqual({ period: "week", date: "2026-10-25" });
    expect(reviewTarget({ period: "year", from: "soon" })).toEqual({ period: "week", date: null });
    expect(reviewTarget(null)).toEqual({ period: "week", date: null });
  });

  test("route params open the period's first day, a missing or future day the last finished one", () => {
    expect(targetFromParams({ period: "week", date: "2026-10-21" }, now)).toEqual({ period: "week", date: "2026-10-19" });
    expect(targetFromParams({ period: ["month"], date: ["2026-09-30"] }, now)).toEqual({ period: "month", date: "2026-09-01" });
    expect(targetFromParams({}, now)).toEqual({ period: "week", date: "2026-10-19" });
    expect(targetFromParams({ period: "month", date: "2027-01-01" }, now)).toEqual({ period: "month", date: "2026-09-01" });
    expect(targetFromParams({ period: "week", date: "2026-02-30" }, now).date).toBe("2026-10-19");
  });

  test("a request waits for the map screen, a listener hears it at once", () => {
    requestReview({ period: "week", date: "2026-10-19" });
    expect(takeRequestedReview()).toEqual({ period: "week", date: "2026-10-19" });
    expect(takeRequestedReview()).toBeNull();
    const heard: unknown[] = [];
    const off = onReviewRequest((target) => heard.push(target));
    requestReview({ period: "month", date: null });
    off();
    requestReview({ period: "week", date: null });
    expect(heard).toEqual([{ period: "month", date: null }]);
    takeRequestedReview();
  });
});

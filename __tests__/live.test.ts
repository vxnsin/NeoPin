// Neither native module exists in tests, like on iOS or in a build from before they existed.
jest.mock("../modules/neopin-live", () => ({ LiveNative: null }));
jest.mock("../modules/neopin-nearby", () => ({ NearbyNative: null }));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import { LIVE_MIN_MS, LiveUpdater, hideLive, liveAvailable, liveContent, onLiveStop, showLive, type ActiveFind } from "../lib/live";
import { LOST_MS } from "../lib/nearby";

const peer = { id: 2, username: "anna", displayName: "Anna", avatarUrl: null };
const mine = { latitude: 49.7937, longitude: 9.9387, accuracy: 8, heading: null, at: 1000 };
// About 420 m north-east of mine.
const theirs = { latitude: 49.7964, longitude: 9.9428, accuracy: 10, heading: null, at: 1000 };
const active = (fix: typeof theirs | null): ActiveFind => ({ phase: "active", session: "s1", peer, expiresAt: 2_000_000, theirs: fix });

test("far away: metres, a hint and the arrow turned in five degree steps", () => {
  const content = liveContent(active(theirs), mine, 10, null, 1000);
  expect(content.title).toBe("Finding Anna");
  expect(content.short).toBe("420 m");
  expect(content.text).toBe("420 m · Still a way to go");
  expect(content.arrowDeg).not.toBeNull();
  expect(content.arrowDeg! % 5).toBe(0);
  expect(content.arrowDeg).toBeGreaterThanOrEqual(0);
  expect(content.arrowDeg).toBeLessThan(360);
  // Without a compass reading there is no arrow, only the advice to turn.
  const blind = liveContent(active(theirs), mine, null, null, 1000);
  expect(blind.arrowDeg).toBeNull();
  expect(blind.text).toBe("420 m · Still a way to go");
});

test("without positions the line says who it waits for", () => {
  expect(liveContent(active(null), mine, 10, null, 1000)).toEqual({
    title: "Finding Anna",
    text: "Waiting for Anna's position…",
    short: "…",
    arrowDeg: null,
  });
  expect(liveContent(active(theirs), null, 10, null, 1000).text).toBe("Waiting for your own position…");
});

test("a fresh Bluetooth reading replaces the arrow with the signal band", () => {
  const close = { ...theirs, latitude: 49.79375, longitude: 9.9388 };
  const fresh = liveContent(active(close), mine, 10, { band: "very-close", rssi: -68, at: 1000 }, 2000);
  expect(fresh.short).toBe("Very close");
  expect(fresh.text).toMatch(/^\d+ m · Look around$/);
  expect(fresh.arrowDeg).toBeNull();
  // A stale reading does not count any more.
  const stale = liveContent(active(close), mine, 10, { band: "very-close", rssi: -68, at: 1000 }, 1001 + LOST_MS);
  expect(stale.short).toMatch(/m$/);
});

test("the updater skips repeats and throttles arrow-only changes", () => {
  const sent: number[] = [];
  const updater = new LiveUpdater((c) => sent.push(c.arrowDeg ?? -1));
  const base = { title: "Finding Anna", text: "420 m · Follow the arrow", short: "420 m", arrowDeg: 40 };
  expect(updater.update(base, 1000)).toBe(true);
  expect(updater.update({ ...base }, 1100)).toBe(false);
  // The arrow alone moved, too soon after the last one.
  expect(updater.update({ ...base, arrowDeg: 45 }, 1200)).toBe(false);
  expect(updater.update({ ...base, arrowDeg: 45 }, 1000 + LIVE_MIN_MS)).toBe(true);
  // New metres go out at once.
  expect(updater.update({ ...base, text: "415 m · Follow the arrow", short: "415 m", arrowDeg: 50 }, 1600)).toBe(true);
  expect(sent).toEqual([40, 45, 50]);
  updater.reset();
  expect(updater.update({ ...base, text: "415 m · Follow the arrow", short: "415 m", arrowDeg: 50 }, 1700)).toBe(true);
});

test("without the native module nothing is shown and nothing breaks", async () => {
  expect(liveAvailable()).toBe(false);
  await expect(showLive({ title: "", text: "", short: "", arrowDeg: null })).resolves.toBe("unavailable");
  expect(() => hideLive()).not.toThrow();
  const off = onLiveStop(() => {});
  expect(() => off()).not.toThrow();
});

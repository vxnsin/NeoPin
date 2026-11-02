jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LocationObject } from "expo-location";
import {
  clearHeldFixes,
  holdFixes,
  reportMessages,
  sendHeldFixes,
  takeHeldFixes,
  toFix,
  type Fix,
} from "../lib/fixes";

const location = (coords: Partial<LocationObject["coords"]>, timestamp = 1_700_000_000_000.4): LocationObject => ({
  timestamp,
  coords: {
    latitude: 49.79,
    longitude: 9.95,
    altitude: null,
    accuracy: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
    ...coords,
  },
});

const fix = (recordedAt: number): Fix => ({ latitude: 49.79, longitude: 9.95, recordedAt });

beforeEach(() => AsyncStorage.clear());

test("a fix carries the GPS time, accuracy and speed", () => {
  expect(toFix(location({ accuracy: 12, speed: 1.4 }))).toEqual({
    latitude: 49.79,
    longitude: 9.95,
    recordedAt: 1_700_000_000_000,
    accuracy: 12,
    speed: 1.4,
  });
});

test("unknown or impossible values stay out, the server would close the socket", () => {
  expect(toFix(location({ accuracy: -1, speed: -1 }))).toEqual({ latitude: 49.79, longitude: 9.95, recordedAt: 1_700_000_000_000 });
  expect(toFix(location({ accuracy: 200_000, speed: 900 }, 0))).toEqual({ latitude: 49.79, longitude: 9.95 });
});

test("a fix carries its GPS height in whole metres, unknown heights stay out", () => {
  expect(toFix(location({ altitude: 412.6, altitudeAccuracy: 4.4 }))).toEqual({
    latitude: 49.79,
    longitude: 9.95,
    recordedAt: 1_700_000_000_000,
    altitude: 413,
    altitudeAccuracy: 4,
  });
  expect(toFix(location({ altitude: 412.6, altitudeAccuracy: -1 }))).toEqual({
    latitude: 49.79,
    longitude: 9.95,
    recordedAt: 1_700_000_000_000,
    altitude: 413,
  });
  expect(toFix(location({ altitude: null, altitudeAccuracy: 3 }))).toEqual({ latitude: 49.79, longitude: 9.95, recordedAt: 1_700_000_000_000 });
  expect(toFix(location({ altitude: 40_000 }))).toEqual({ latitude: 49.79, longitude: 9.95, recordedAt: 1_700_000_000_000 });
});

test("older fixes go out in batches of 75, the newest as a normal update", () => {
  const older = Array.from({ length: 150 }, (_, i) => fix(i));
  const live = { type: "updatePosition", ...fix(200) };
  const messages = reportMessages(older, live, ["positionBatch"]);
  expect(messages.map((m) => m.type)).toEqual(["positionBatch", "positionBatch", "updatePosition"]);
  expect(messages[0].points).toHaveLength(75);
  expect(messages[1].points).toHaveLength(75);
});

test("a full batch of fixes with heights stays below the server's 16 KiB", () => {
  const precise = Array.from({ length: 200 }, (_, i) => ({
    latitude: 49.791234567890123,
    longitude: 9.951234567890123,
    recordedAt: 1_700_000_000_000 + i,
    accuracy: 12.345678901234567,
    speed: 1.4123456789012345,
    altitude: 4123,
    altitudeAccuracy: 123,
  }));
  const [batch] = reportMessages(precise, null, ["positionBatch"]);
  expect(JSON.stringify(batch).length).toBeLessThan(16 * 1024);
});

test("a server without batches only gets the newest fix", () => {
  const live = { type: "updatePosition", ...fix(200) };
  expect(reportMessages([fix(1), fix(2)], live, [])).toEqual([live]);
});

test("held fixes come back in time order once and are gone afterwards", async () => {
  await holdFixes([fix(30), fix(10)]);
  await holdFixes([fix(20)]);
  expect((await takeHeldFixes()).map((f) => f.recordedAt)).toEqual([10, 20, 30]);
  expect(await takeHeldFixes()).toEqual([]);
});

test("holding keeps only the newest few days worth", async () => {
  await holdFixes(Array.from({ length: 5_010 }, (_, i) => fix(i)));
  const held = await takeHeldFixes();
  expect(held).toHaveLength(5_000);
  expect(held[0].recordedAt).toBe(10);
});

test("a logout forgets what was held", async () => {
  await holdFixes([fix(1)]);
  await clearHeldFixes();
  expect(await takeHeldFixes()).toEqual([]);
});

test("held fixes go out as a batch once a capable server is back", async () => {
  await holdFixes([fix(1), fix(2)]);
  const emit = jest.fn();
  await sendHeldFixes({ emit, features: ["positionBatch"] });
  expect(emit).toHaveBeenCalledWith({ type: "positionBatch", points: [fix(1), fix(2)] });
  expect(await takeHeldFixes()).toEqual([]);
});

test("an older server gets nothing, the held fixes do not pile up", async () => {
  await holdFixes([fix(1)]);
  const emit = jest.fn();
  await sendHeldFixes({ emit, features: [] });
  expect(emit).not.toHaveBeenCalled();
  expect(await takeHeldFixes()).toEqual([]);
});

test("a fix both reporters get is sent live only once", () => {
  const { firstTimeLive, resetLiveFixes } = require("../lib/fixes");
  resetLiveFixes();
  const fix = { latitude: 50.2918, longitude: 11.4531, recordedAt: 1_000_000 };
  expect(firstTimeLive(fix)).toBe(true);
  expect(firstTimeLive({ ...fix })).toBe(false);
  expect(firstTimeLive({ ...fix, recordedAt: 1_000_400 })).toBe(false);
  expect(firstTimeLive({ ...fix, recordedAt: 1_015_000 })).toBe(true);
  expect(firstTimeLive({ ...fix, latitude: 50.2928, recordedAt: 1_015_000 })).toBe(true);
  // The still-beat has no time of its own and always goes out.
  expect(firstTimeLive({ latitude: 50.2918, longitude: 11.4531 })).toBe(true);
  expect(firstTimeLive({ latitude: 50.2918, longitude: 11.4531 })).toBe(true);
});

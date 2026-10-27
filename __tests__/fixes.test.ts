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

test("older fixes go out in batches of 100, the newest as a normal update", () => {
  const older = Array.from({ length: 150 }, (_, i) => fix(i));
  const live = { type: "updatePosition", ...fix(200) };
  const messages = reportMessages(older, live, ["positionBatch"]);
  expect(messages.map((m) => m.type)).toEqual(["positionBatch", "positionBatch", "updatePosition"]);
  expect(messages[0].points).toHaveLength(100);
  expect(messages[1].points).toHaveLength(50);
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

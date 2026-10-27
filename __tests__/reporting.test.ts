// The GPS is faked: watch delivers what a test pushes, a one-off fix comes from `current`.
const gps = {
  watch: null as ((location: any) => void) | null,
  current: { latitude: 49.79, longitude: 9.95 },
  oneOffs: 0,
};

jest.mock("expo-location", () => ({
  Accuracy: { Balanced: 3, High: 4 },
  getForegroundPermissionsAsync: () => Promise.resolve({ status: "granted" }),
  watchPositionAsync: (_options: unknown, callback: (location: any) => void) => {
    gps.watch = callback;
    return Promise.resolve({ remove: () => (gps.watch = null) });
  },
  getCurrentPositionAsync: () => {
    gps.oneOffs += 1;
    return Promise.resolve({ timestamp: Date.now(), coords: { ...gps.current, accuracy: 20, speed: 0 } });
  },
}));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("../lib/battery", () => ({
  readBattery: () => Promise.resolve(null),
  serverTakesBattery: () => false,
  watchBattery: () => () => {},
}));

import { startPositionReporting } from "../handlers/Location";

const INTERVAL = 15_000;
let sent: any[];
let stop: () => void;

beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ["setImmediate"] });
  gps.oneOffs = 0;
  gps.current = { latitude: 49.79, longitude: 9.95 };
  sent = [];
  stop = startPositionReporting({ emit: (msg) => sent.push(msg) }, { timeInterval: INTERVAL });
  await jest.advanceTimersByTimeAsync(0);
});

afterEach(() => {
  stop();
  jest.useRealTimers();
});

test("a moving phone reports each fix with its GPS time, accuracy and speed", async () => {
  gps.watch!({ timestamp: Date.now() - 1_000, coords: { latitude: 49.8, longitude: 9.96, accuracy: 8, speed: 12 } });
  await jest.advanceTimersByTimeAsync(0);
  expect(sent).toEqual([
    { type: "updatePosition", latitude: 49.8, longitude: 9.96, recordedAt: Date.now() - 1_000, accuracy: 8, speed: 12 },
  ]);
});

test("a phone lying still stops waking the GPS and repeats its spot as of now", async () => {
  // The first beats ask the GPS, the phone does not move.
  await jest.advanceTimersByTimeAsync(3 * 60_000 + INTERVAL);
  const asked = gps.oneOffs;
  expect(asked).toBeGreaterThan(0);

  await jest.advanceTimersByTimeAsync(INTERVAL * 4);
  expect(gps.oneOffs).toBe(asked);
  const last = sent[sent.length - 1];
  expect(last).toEqual({ type: "updatePosition", latitude: 49.79, longitude: 9.95, accuracy: 20 });
});

test("lying still, the GPS is still asked every few minutes", async () => {
  await jest.advanceTimersByTimeAsync(3 * 60_000 + INTERVAL);
  const asked = gps.oneOffs;
  await jest.advanceTimersByTimeAsync(5 * 60_000 + INTERVAL);
  expect(gps.oneOffs).toBeGreaterThan(asked);
});

test("moving again brings the fresh fixes back", async () => {
  await jest.advanceTimersByTimeAsync(4 * 60_000);
  gps.watch!({ timestamp: Date.now(), coords: { latitude: 49.81, longitude: 9.97, accuracy: 5, speed: 4 } });
  await jest.advanceTimersByTimeAsync(0);
  const asked = gps.oneOffs;
  await jest.advanceTimersByTimeAsync(INTERVAL * 2);
  expect(gps.oneOffs).toBeGreaterThan(asked);
});

// expo-battery as a build that has its native module: level and state are set per test.
const native = { level: 0.64, state: 1, listeners: [] as (() => void)[] };

jest.mock("expo", () => ({ requireOptionalNativeModule: () => ({}) }));
jest.mock("expo-battery", () => ({
  getBatteryLevelAsync: () => Promise.resolve(native.level),
  getBatteryStateAsync: () => Promise.resolve(native.state),
  addBatteryLevelListener: (fn: () => void) => {
    native.listeners.push(fn);
    return { remove: () => (native.listeners = native.listeners.filter((l) => l !== fn)) };
  },
  addBatteryStateListener: (fn: () => void) => {
    native.listeners.push(fn);
    return { remove: () => (native.listeners = native.listeners.filter((l) => l !== fn)) };
  },
}));

import { readBattery, toReport, watchBattery } from "../lib/battery";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const fire = async () => {
  native.listeners.forEach((fn) => fn());
  await flush();
};

beforeEach(() => {
  native.level = 0.64;
  native.state = 1;
  native.listeners = [];
});

test("turns the level into whole percent and charging or full into plugged in", () => {
  expect(toReport(0.643, 1)).toEqual({ level: 64, charging: false });
  expect(toReport(0.5, 2)).toEqual({ level: 50, charging: true });
  expect(toReport(1, 3)).toEqual({ level: 100, charging: true });
  expect(toReport(0.2, 4)).toEqual({ level: 20, charging: false });
});

test("a simulator without a battery reports none", () => {
  expect(toReport(-1, 0)).toBeNull();
  expect(toReport(Number.NaN, 0)).toBeNull();
});

test("reads the battery from the native module", async () => {
  native.level = 0.12;
  native.state = 2;
  expect(await readBattery()).toEqual({ level: 12, charging: true });
});

test("reports a change once, not every time the system calls", async () => {
  const seen: unknown[] = [];
  const stop = watchBattery((report) => seen.push(report));

  await fire();
  await fire();
  native.state = 2;
  await fire();
  native.level = 0.65;
  await fire();

  expect(seen).toEqual([
    { level: 64, charging: false },
    { level: 64, charging: true },
    { level: 65, charging: true },
  ]);

  stop();
  expect(native.listeners).toHaveLength(0);
});

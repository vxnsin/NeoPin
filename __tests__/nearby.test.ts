// The native module is absent in tests, like in a build from before it existed.
jest.mock("../modules/neopin-nearby", () => ({ NearbyNative: null }));

import { LOST_MS, MET_MS, SignalTracker, nearbyAvailable, nearbyHint, nearbyText, sessionUuid, signalBand, startNearby } from "../lib/nearby";

test("the session id becomes a UUID both phones agree on, without any name in it", () => {
  const uuid = sessionUuid("AQIDBAUGBwgJ");
  expect(uuid).toBe("01020304-0506-0708-096e-656f70696e21");
  expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(sessionUuid("AQIDBAUGBwgJ")).toBe(uuid);
  expect(sessionUuid("AQIDBAUGBwgK")).not.toBe(uuid);
  // The two base64url letters past the plain alphabet decode too.
  expect(sessionUuid("-_-_-_-_-_-_")).toMatch(/^fbf/);
});

test("signal strength falls into four bands", () => {
  expect(signalBand(-50)).toBe("here");
  expect(signalBand(-65)).toBe("very-close");
  expect(signalBand(-80)).toBe("close");
  expect(signalBand(-95)).toBe("around");
  expect(nearbyText("very-close")).toBe("Very close");
});

test("readings are smoothed, go stale after a while, and a few seconds right here means met", () => {
  const tracker = new SignalTracker();
  expect(tracker.reading(0)).toBeNull();
  expect(tracker.add({ rssi: -80, at: 1000 })).toEqual({ band: "close", rssi: -80, at: 1000 });
  // One strong reading does not jump all the way.
  const next = tracker.add({ rssi: -50, at: 2000 });
  expect(next.rssi).toBe(-68);
  expect(next.band).toBe("very-close");
  expect(tracker.reading(2000 + LOST_MS)).not.toBeNull();
  expect(tracker.reading(2001 + LOST_MS)).toBeNull();

  tracker.add({ rssi: -50, at: 3000 });
  tracker.add({ rssi: -50, at: 4000 });
  expect(tracker.add({ rssi: -50, at: 5000 }).band).toBe("here");
  expect(tracker.met(5000)).toBe(false);
  tracker.add({ rssi: -50, at: 5000 + MET_MS });
  expect(tracker.met(5000 + MET_MS)).toBe(true);
  // Drifting apart again cancels the meeting.
  tracker.add({ rssi: -90, at: 9000 });
  tracker.add({ rssi: -90, at: 9500 });
  expect(tracker.met(9500)).toBe(false);
});

test("without the native module nothing starts and the state says so", () => {
  expect(nearbyAvailable()).toBe(false);
  const states: string[] = [];
  const stop = startNearby("AQIDBAUGBwgJ", () => {}, (state) => states.push(state));
  expect(states).toEqual(["unavailable"]);
  stop();
  expect(nearbyHint("unavailable")).toBeNull();
  expect(nearbyHint("off")).toMatch(/Turn on Bluetooth/);
});

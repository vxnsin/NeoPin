import * as Location from "expo-location";
import type { Message } from "@/lib/SocketClient";
import { readBattery, serverTakesBattery, watchBattery } from "@/lib/battery";
import { distanceM, toFix, type Fix } from "@/lib/fixes";

type Emitter = { emit: (msg: Message) => void };

export type ReportingOptions = {
  timeInterval?: number;
  distanceInterval?: number;
  accuracy?: Location.Accuracy;
};

// A phone that stayed within this radius for this long lies still. The beat then stops
// waking the GPS and repeats the last spot, with a fresh fix every few minutes.
const STILL_RADIUS_M = 50;
const STILL_AFTER_MS = 3 * 60_000;
const STILL_REFRESH_MS = 5 * 60_000;

// Pushes the own position to the server whenever the device moves, so the
// server always holds a recent fix even when a requestLocation cannot reach us.
export function startPositionReporting(target: Emitter, options: ReportingOptions = {}): () => void {
  let subscription: Location.LocationSubscription | null = null;
  let cancelled = false;
  let lastSent = 0;
  const interval = options.timeInterval ?? 15_000;

  let lastFix: Fix | null = null;
  let lastFixAt = 0;
  // Where the phone last moved to and when, to tell moving from lying still.
  let anchor: Fix | null = null;
  let movedAt = Date.now();

  const send = async (fix: Fix) => {
    lastSent = Date.now();
    const battery = await readBattery();
    // Reporting may have stopped while the battery was read, a logout for example.
    if (cancelled) return;
    target.emit({ type: "updatePosition", ...fix, ...(battery && { battery }) });
  };

  const fresh = (fix: Fix) => {
    lastFix = fix;
    lastFixAt = Date.now();
    if (!anchor || distanceM(anchor, fix) > STILL_RADIUS_M) {
      anchor = fix;
      movedAt = lastFixAt;
    }
    send(fix);
  };

  // A phone on the charger may not move at all, its battery still changes.
  const stopBattery = watchBattery((battery) => {
    if (serverTakesBattery()) target.emit({ type: "updateBattery", ...battery });
  });

  // iOS ignores timeInterval and only reports movement, so a phone that lies still
  // would go silent. This beat keeps the last ping fresh.
  const beat = setInterval(async () => {
    const now = Date.now();
    if (cancelled || now - lastSent < interval) return;
    if (lastFix && now - movedAt > STILL_AFTER_MS && now - lastFixAt < STILL_REFRESH_MS) {
      // Still at the same spot: that spot as of now, the GPS stays off.
      const { recordedAt, speed, ...here } = lastFix;
      send(here);
      return;
    }
    try {
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (!cancelled) fresh(toFix(position));
    } catch {
      // no fix right now, the next beat tries again
    }
  }, interval);

  (async () => {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== "granted" || cancelled) return;

    subscription = await Location.watchPositionAsync(
      {
        accuracy: options.accuracy ?? Location.Accuracy.High,
        timeInterval: options.timeInterval ?? 15_000,
        distanceInterval: options.distanceInterval ?? 10,
      },
      (location) => fresh(toFix(location))
    );

    if (cancelled) subscription.remove();
  })().catch((error) => console.warn("Position reporting failed:", error));

  return () => {
    cancelled = true;
    clearInterval(beat);
    stopBattery();
    subscription?.remove();
    subscription = null;
  };
}

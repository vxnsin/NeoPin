import * as Location from "expo-location";
import type { Message } from "@/lib/SocketClient";
import { readBattery, watchBattery } from "@/lib/battery";

type Emitter = { emit: (msg: Message) => void };

export type ReportingOptions = {
  timeInterval?: number;
  distanceInterval?: number;
  accuracy?: Location.Accuracy;
};

// Pushes the own position to the server whenever the device moves, so the
// server always holds a recent fix even when a requestLocation cannot reach us.
export function startPositionReporting(target: Emitter, options: ReportingOptions = {}): () => void {
  let subscription: Location.LocationSubscription | null = null;
  let cancelled = false;
  let lastSent = 0;
  const interval = options.timeInterval ?? 15_000;

  const send = async (latitude: number, longitude: number) => {
    lastSent = Date.now();
    const battery = await readBattery();
    target.emit({ type: "updatePosition", latitude, longitude, ...(battery && { battery }) });
  };

  // A phone on the charger may not move at all, its battery still changes.
  const stopBattery = watchBattery((battery) => target.emit({ type: "updateBattery", ...battery }));

  // iOS ignores timeInterval and only reports movement, so a phone that lies still
  // would go silent. This beat keeps the last ping fresh.
  const beat = setInterval(async () => {
    if (cancelled || Date.now() - lastSent < interval) return;
    try {
      const { coords } = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (!cancelled) send(coords.latitude, coords.longitude);
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
      (location) => send(location.coords.latitude, location.coords.longitude)
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

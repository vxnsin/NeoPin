import * as Location from "expo-location";
import type { Message } from "@/lib/SocketClient";

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

  (async () => {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== "granted" || cancelled) return;

    subscription = await Location.watchPositionAsync(
      {
        accuracy: options.accuracy ?? Location.Accuracy.High,
        timeInterval: options.timeInterval ?? 15_000,
        distanceInterval: options.distanceInterval ?? 10,
      },
      (location) => {
        target.emit({
          type: "updatePosition",
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        });
      }
    );

    if (cancelled) subscription.remove();
  })().catch((error) => console.warn("Position reporting failed:", error));

  return () => {
    cancelled = true;
    subscription?.remove();
    subscription = null;
  };
}

import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import { Platform } from "react-native";
import { socket, readCredentials, type StoredCredentials } from "@/lib/socket";

export const LOCATION_TASK = "neopin-background-location";

const PUSH_TIMEOUT_MS = 8_000;

// iOS cannot keep a WebSocket open in the background. Instead the system wakes
// this task on movement and we push the fresh position with a short-lived
// connection (or over the shared socket if the app is still alive).
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const locations = (data as { locations?: Location.LocationObject[] }).locations ?? [];
  const latest = locations[locations.length - 1];
  if (!latest) return;

  const message = {
    type: "updatePosition",
    latitude: latest.coords.latitude,
    longitude: latest.coords.longitude,
  };

  if (socket.connected) {
    socket.emit(message);
    return;
  }

  const creds = await readCredentials();
  if (!creds) return;
  await pushOnce(creds, message).catch((err) => console.warn("Background push failed:", err?.message));
});

function pushOnce(creds: StoredCredentials, message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(creds.serverIp);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout"));
    }, PUSH_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      ws.close();
      fn();
    };

    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "authenticate", deviceId: creds.deviceId, password: creds.password }));
    ws.onmessage = (event) => {
      try {
        const reply = JSON.parse(event.data);
        if (reply.successful) {
          ws.send(JSON.stringify(message));
          finish(resolve);
        } else if ("successful" in reply) {
          finish(() => reject(new Error("authentication failed")));
        }
      } catch {
        finish(() => reject(new Error("bad reply")));
      }
    };
    ws.onerror = () => finish(() => reject(new Error("connection error")));
  });
}

export async function startBackgroundLocation(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;

  const foreground = await Location.getForegroundPermissionsAsync();
  if (foreground.status !== "granted") return false;
  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== "granted") return false;

  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return true;

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 60_000,
    distanceInterval: 50,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    activityType: Location.ActivityType.Other,
  });
  return true;
}

export async function stopBackgroundLocation() {
  if (Platform.OS !== "ios") return;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

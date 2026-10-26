import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import { AppState } from "react-native";
import { currentDeviceType } from "@/lib/deviceType";
import { socket, readCredentials, type StoredCredentials } from "@/lib/socket";

export const LOCATION_TASK = "neopin-background-location";

const PUSH_TIMEOUT_MS = 8_000;

// The system wakes this task on movement, also while the app is in the background.
// We push the fresh position over the shared socket if it is still alive, or with a
// short-lived connection of our own.
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
      ws.send(JSON.stringify({ type: "authenticate", deviceId: creds.deviceId, token: creds.token, deviceType: currentDeviceType() }));
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

export type BackgroundOptions = { timeInterval: number; distanceInterval: number; accuracy: Location.Accuracy };

// Keeps reporting while the app is in the background or closed. On Android this
// runs as a foreground service with a notification, on iOS the system wakes the
// task on movement. Restarting applies a changed update preset.
export async function startBackgroundLocation(options: BackgroundOptions): Promise<boolean> {
  // The permission dialogs belong to the setup flow (hooks/usePermission). Asking again here while
  // that flow runs makes two requests collide, and starting the foreground service while the app is
  // not in front is refused by Android 12 and newer, which kills the app.
  if (AppState.currentState !== "active") return false;
  const foreground = await Location.getForegroundPermissionsAsync();
  if (foreground.status !== "granted") return false;
  const background = await Location.getBackgroundPermissionsAsync().catch(() => null);
  if (background?.status !== "granted") return false;

  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: options.accuracy,
    timeInterval: options.timeInterval,
    distanceInterval: options.distanceInterval,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    activityType: Location.ActivityType.Other,
    foregroundService: {
      notificationTitle: "NeoPin is sharing your location",
      notificationBody: "Connected to your server",
      notificationColor: "#d3171e",
      killServiceOnDestroy: false,
    },
  });
  return true;
}

export async function stopBackgroundLocation() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

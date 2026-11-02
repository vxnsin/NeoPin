import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import { AppState } from "react-native";
import { currentDeviceType } from "@/lib/deviceType";
import { readBattery } from "@/lib/battery";
import { logBattery, logEvent, logFix, type FixSource } from "@/lib/diagnostics";
import { BATCH_FEATURE, firstTimeLive, holdFixes, reportMessages, takeHeldFixes, toFix, type Fix } from "@/lib/fixes";
import type { Message } from "@/lib/SocketClient";
import { reportInterval } from "@/lib/reportInterval";
import { loadSettings } from "@/lib/settings";
import { socket, readCredentials, type StoredCredentials } from "@/lib/socket";

export const LOCATION_TASK = "neopin-background-location";

const PUSH_TIMEOUT_MS = 8_000;

// The system wakes this task on movement, also while the app is in the background.
// We push the fresh position over the shared socket if it is still alive, or with a
// short-lived connection of our own.
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  // The system may hand over several fixes at once, iOS does when it defers updates.
  const fixes = ((data as { locations?: Location.LocationObject[] }).locations ?? []).map(toFix);
  await reportFixes(fixes);
});

// Sends the newest of these fixes as the live position, the older ones as history. It uses the shared
// socket if it is alive, or a short-lived connection of our own. Without a connection everything is
// held on the phone for the next one.
export async function reportFixes(fixes: Fix[], source: FixSource = "background"): Promise<void> {
  const latest = fixes.pop();
  if (!latest) return;

  const battery = await readBattery();
  logBattery(battery);
  const live = { type: "updatePosition", ...latest, ...(battery && { battery }) };

  if (socket.connected) {
    const older = [...(await takeHeldFixes()), ...fixes];
    // With the app open the foreground watch may have sent this very fix already.
    const first = firstTimeLive(latest);
    logReport(source, older, latest, first ? "live" : "dup", socket.features);
    reportMessages(older, first ? live : null, socket.features).forEach((msg) => socket.emit(msg));
    return;
  }

  const creds = await readCredentials();
  if (!creds) return;
  // The task may run without the app, the preset has to come from storage then.
  await loadSettings();
  const older = [...(await takeHeldFixes()), ...fixes];
  try {
    await pushOnce(creds, (features) => {
      logReport(source, older, latest, "live", features);
      return reportMessages(older, live, features);
    });
  } catch (err: any) {
    // No connection right now: everything waits on the phone for the next one.
    logEvent("socket", { event: "push-failed", reason: err?.message ?? "unknown" });
    logReport(source, older, latest, "held", []);
    await holdFixes([...older, latest]);
    console.warn("Background push failed:", err?.message);
  }
}

// For the diagnostics log: the older fixes go out as history where the server takes batches, are
// dropped where it does not, and wait on the phone without a connection.
function logReport(source: FixSource, older: Fix[], latest: Fix, outcome: "live" | "dup" | "held", features: readonly string[]) {
  const history = outcome === "held" ? "held" : features.includes(BATCH_FEATURE) ? "batch" : null;
  if (history) older.forEach((fix) => logFix(source, fix, history));
  logFix(source, latest, outcome);
}

// Logs in, sends what messagesFor returns for the server's features, and closes again.
function pushOnce(creds: StoredCredentials, messagesFor: (features: string[]) => Message[]): Promise<void> {
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
      ws.send(
        JSON.stringify({
          type: "authenticate",
          deviceId: creds.deviceId,
          token: creds.token,
          deviceType: currentDeviceType(),
          // How often it reports: the server keeps it online between these short visits.
          interval: reportInterval(),
        })
      );
    ws.onmessage = (event) => {
      try {
        const reply = JSON.parse(event.data);
        if (reply.successful) {
          const features = Array.isArray(reply.features) ? reply.features : [];
          messagesFor(features).forEach((msg) => ws.send(JSON.stringify(msg)));
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

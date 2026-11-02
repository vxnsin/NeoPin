import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import { AppState, Platform, Share } from "react-native";
import { uploadDiagnosticsRequest, type DeviceAuth } from "@/lib/api";
import { readBattery } from "@/lib/battery";
import { diagnosticsEvents, logEvent, type DiagValue } from "@/lib/diagnostics";
import { buildDiagnosticsZip, type DiagnosticsInfo } from "@/lib/diagnosticsZip";
import { reportInterval } from "@/lib/reportInterval";
import { getMap3d, getReportingPreset } from "@/lib/settings";
import { socket } from "@/lib/socket";
import { LOCATION_TASK } from "@/tasks/LocationTask";

// The export of the developer settings: the log as a zip, uploaded to the own server, and the
// link it answers with handed to the share sheet. The app has no file system or share module of
// its own (an OTA update cannot add them), so a link is what can be shared.

const status = (promise: Promise<{ status: string }>) => promise.then((p) => p.status, () => "unknown");

async function collectInfo(username: string | null): Promise<DiagnosticsInfo> {
  const [foreground, background, notifications, reporting, battery] = await Promise.all([
    status(Location.getForegroundPermissionsAsync()),
    status(Location.getBackgroundPermissionsAsync()),
    status(Notifications.getPermissionsAsync()),
    Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => null),
    readBattery(),
  ]);
  const device: Record<string, DiagValue> = {
    platform: Platform.OS,
    os: Device.osName ?? null,
    osVersion: Device.osVersion ?? null,
    model: Device.modelName ?? null,
    brand: Device.brand ?? null,
    isDevice: Device.isDevice,
    batteryLevel: battery?.level ?? null,
    charging: battery?.charging ?? null,
  };
  const app: Record<string, DiagValue> = {
    version: Constants.expoConfig?.version ?? null,
    nativeVersion: Constants.nativeAppVersion ?? null,
    nativeBuild: Constants.nativeBuildVersion ?? null,
    channel: Updates.channel ?? null,
    runtimeVersion: Updates.runtimeVersion ?? null,
    updateId: Updates.updateId ?? null,
    updateCreatedAt: Updates.createdAt ? Updates.createdAt.toISOString() : null,
    embeddedLaunch: Updates.isEmbeddedLaunch,
    dev: __DEV__,
    appState: AppState.currentState ?? null,
    socketConnected: socket.connected,
  };
  return {
    username,
    device,
    app,
    permissions: { foreground, background, notifications, backgroundReporting: reporting },
    settings: {
      reporting: getReportingPreset(),
      map3d: getMap3d(),
      reportIntervalMs: reportInterval() ?? null,
      serverFeatures: socket.features.join(",") || null,
    },
  };
}

export async function buildExport(username: string | null): Promise<Uint8Array> {
  logEvent("export");
  const [events, info] = await Promise.all([diagnosticsEvents(), collectInfo(username)]);
  return buildDiagnosticsZip(events, info);
}

// Uploads the zip and opens the share sheet with the link. Resolves with the link, or throws
// with a message for people when the server did not take it.
export async function exportDiagnostics(auth: DeviceAuth & { user: { username: string } }): Promise<string> {
  const zip = await buildExport(auth.user.username);
  const { url, expiresAt } = await uploadDiagnosticsRequest(auth, zip);
  const until = new Date(expiresAt).toLocaleDateString();
  // The link inside the text: Discord and most chats take that, a separate url item ends up twice.
  await Share.share({ message: `NeoPin diagnostics, until ${until}: ${url}`, title: "NeoPin diagnostics" });
  return url;
}

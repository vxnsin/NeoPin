import { Platform } from "react-native";
import BackgroundService from "react-native-background-actions";
import { socket, readCredentials } from "@/lib/socket";

const CHECK_INTERVAL_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Android only. The foreground service keeps the JS runtime alive while the app
// is in the background, so the shared socket, its heartbeat and the position
// reporter keep running. The task itself just makes sure we are connected.
const keepAlive = async () => {
  while (BackgroundService.isRunning()) {
    if (!socket.connected && !socket.reconnectPending) {
      const creds = await readCredentials();
      if (!creds) break;
      try {
        await socket.connect(creds.serverIp, creds.deviceId, creds.password);
      } catch (error: any) {
        console.warn("Background connect failed:", error?.message);
      }
    }
    await sleep(CHECK_INTERVAL_MS);
  }
};

const options = {
  taskName: "NeoPin",
  taskTitle: "NeoPin is sharing your location",
  taskDesc: "Connected to your server",
  taskIcon: { name: "ic_launcher", type: "mipmap" },
  color: "#d3171e",
  linkingURI: "de.vensin.neopin://",
};

export async function startWebSocketService() {
  if (Platform.OS !== "android" || BackgroundService.isRunning()) return;
  try {
    await BackgroundService.start(keepAlive, options);
  } catch (error) {
    console.error("Background service error:", error);
  }
}

export async function stopWebSocketService() {
  if (Platform.OS !== "android" || !BackgroundService.isRunning()) return;
  try {
    await BackgroundService.stop();
  } catch (error) {
    console.error("Background service stop error:", error);
  }
}

import AsyncStorage from "@react-native-async-storage/async-storage";
import { SocketClient } from "@/lib/SocketClient";
import { registerHandlers } from "@/handlers/WebSocket";

export const STORAGE_KEY = "userData";

export type StoredCredentials = {
  serverIp: string;
  deviceId: string;
  password: string;
};

// One socket for the whole app. The UI, the Android foreground service and the
// iOS location task all share this instance, so the server only ever sees a
// single connection per device.
export const socket = new SocketClient();
registerHandlers(socket);

export async function readCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredCredentials) : null;
  } catch {
    return null;
  }
}

export async function connectWithStoredCredentials(): Promise<boolean> {
  const creds = await readCredentials();
  if (!creds) return false;
  await socket.connect(creds.serverIp, creds.deviceId, creds.password);
  return true;
}

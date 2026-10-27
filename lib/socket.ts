import { SocketClient } from "@/lib/SocketClient";
import { registerHandlers } from "@/handlers/WebSocket";
import { readCredentials } from "@/lib/credentials";
import { loadSettings, onSettingsChange } from "@/lib/settings";

export { readCredentials };
export type { StoredCredentials } from "@/lib/credentials";

// One socket for the whole app. The UI, the Android foreground service and the
// iOS location task all share this instance, so the server only ever sees a
// single connection per device.
// The login carries the report interval, so the saved preset has to be loaded first.
export const socket = new SocketClient(loadSettings);
registerHandlers(socket);
// A changed preset changes the interval, the server learns it with a fresh login.
onSettingsChange(() => socket.relogin());

export async function connectWithStoredCredentials(): Promise<boolean> {
  const creds = await readCredentials();
  if (!creds) return false;
  await socket.connect(creds.serverIp, creds.deviceId, creds.token);
  return true;
}

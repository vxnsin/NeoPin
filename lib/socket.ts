import { SocketClient } from "@/lib/SocketClient";
import { registerHandlers } from "@/handlers/WebSocket";
import { readCredentials } from "@/lib/credentials";
import { sendHeldFixes } from "@/lib/fixes";
import { holdFindRequest } from "@/lib/findInbox";
import { loadSettings, onSettingsChange } from "@/lib/settings";

export { readCredentials };
export type { StoredCredentials } from "@/lib/credentials";

// One socket for the whole app. The UI, the Android foreground service and the
// iOS location task all share this instance, so the server only ever sees a
// single connection per device.
// The login carries the report interval, so the saved preset has to be loaded first.
export const socket = new SocketClient(loadSettings);
registerHandlers(socket);
socket.onMessage(holdFindRequest);
// Fixes the background task could not deliver go out as soon as the socket is back.
socket.onStatus((connected) => {
  if (connected) sendHeldFixes(socket).catch(() => {});
});
// A changed preset changes the interval, the server learns it with a fresh login.
onSettingsChange(() => socket.relogin());

export async function connectWithStoredCredentials(): Promise<boolean> {
  const creds = await readCredentials();
  if (!creds) return false;
  await socket.connect(creds.serverIp, creds.deviceId, creds.token);
  return true;
}

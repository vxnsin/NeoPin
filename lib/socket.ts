import { SocketClient } from "@/lib/SocketClient";
import { registerHandlers } from "@/handlers/WebSocket";
import { readCredentials } from "@/lib/credentials";
import { sendHeldFixes } from "@/lib/fixes";

export { readCredentials };
export type { StoredCredentials } from "@/lib/credentials";

// One socket for the whole app. The UI, the Android foreground service and the
// iOS location task all share this instance, so the server only ever sees a
// single connection per device.
export const socket = new SocketClient();
registerHandlers(socket);
// Fixes the background task could not deliver go out as soon as the socket is back.
socket.onStatus((connected) => {
  if (connected) sendHeldFixes(socket).catch(() => {});
});

export async function connectWithStoredCredentials(): Promise<boolean> {
  const creds = await readCredentials();
  if (!creds) return false;
  await socket.connect(creds.serverIp, creds.deviceId, creds.token);
  return true;
}

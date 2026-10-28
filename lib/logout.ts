import { socket, readCredentials } from "@/lib/socket";
import { clearCredentials } from "@/lib/credentials";
import { logoutRequest } from "@/lib/api";
import { stopBackgroundLocation } from "@/tasks/LocationTask";
import { resetServerBattery } from "@/lib/battery";
import { clearHeldFixes } from "@/lib/fixes";
import { clearWidgets } from "@/lib/widgets";

// Closes the socket, stops everything that would reconnect it in the
// background and forgets the stored login. With remote the server drops the
// token as well (best effort), without it the token is already invalid.
export async function logout({ remote = true }: { remote?: boolean } = {}) {
  const creds = remote ? await readCredentials() : null;
  socket.close();
  resetServerBattery();
  await Promise.all([
    stopBackgroundLocation().catch(() => {}),
    clearHeldFixes().catch(() => {}),
    creds ? logoutRequest(creds) : Promise.resolve(),
  ]);
  await clearCredentials();
  clearWidgets();
}

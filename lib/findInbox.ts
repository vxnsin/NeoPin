import type { Message } from "./SocketClient";

// A find request can arrive right after login, before the map screen is there to listen (cold start from
// a notification). It waits here until the screen takes it, or until it has expired.
let waiting: Message | null = null;

export function holdFindRequest(msg: Message) {
  if (msg.type === "findRequest") waiting = msg;
  else if (msg.type === "findEnded" && waiting && (msg.session === null || msg.session === waiting.session)) waiting = null;
}

export function takeFindRequest(now = Date.now()): Message | null {
  const msg = waiting;
  waiting = null;
  return msg && typeof msg.expiresAt === "number" && msg.expiresAt > now ? msg : null;
}

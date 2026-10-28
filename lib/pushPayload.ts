// What a push message means for the app. Kept free of native modules so it can be tested.

export type PushAction =
  | { type: "requestLocation"; from: string; id: string | null }
  | { type: "groupInvite" }
  | { type: "findRequest"; session: string; from: string };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    return asObject(JSON.parse(value));
  } catch {
    return null;
  }
}

// The data of a push shows up in different places. FCM data keys arrive flat in `data` (Android task and
// notification content), the Expo style keeps a JSON string in `dataString`, and the task payload of a
// tapped notification wraps the same content in notification.request.content.
function dataOf(input: unknown): Record<string, unknown> | null {
  const root = asObject(input);
  if (!root) return null;

  const content = asObject(asObject(asObject(root.notification)?.request)?.content) ?? asObject(asObject(root.request)?.content);
  const holder = content ?? root;

  const flat = asObject(holder.data);
  if (flat && typeof flat.type === "string") return flat;
  const fromString = parseJson(holder.dataString) ?? parseJson(flat?.dataString) ?? parseJson(flat?.body);
  if (fromString && typeof fromString.type === "string") return fromString;
  return typeof holder.type === "string" ? holder : null;
}

export function parsePushAction(input: unknown): PushAction | null {
  const data = dataOf(input);
  if (!data) return null;
  if (data.type === "groupInvite") return { type: "groupInvite" };
  if (data.type === "findRequest") {
    const session = typeof data.session === "string" ? data.session : "";
    return { type: "findRequest", session, from: typeof data.from === "string" ? data.from : "" };
  }
  if (data.type === "requestLocation") {
    const from = typeof data.from === "string" && data.from ? data.from : "";
    return { type: "requestLocation", from, id: typeof data.id === "string" && data.id ? data.id : null };
  }
  return null;
}

export type StoredPush = { token: string; serverIp: string; deviceId: string; auth: string };

// The server has to hear about a token once per token and login, not on every start.
export function needsRegistration(stored: StoredPush | null, current: StoredPush): boolean {
  if (!stored) return true;
  return (
    stored.token !== current.token ||
    stored.serverIp !== current.serverIp ||
    stored.deviceId !== current.deviceId ||
    stored.auth !== current.auth
  );
}

// A wake-up can reach the app twice (task and foreground listener), the second one is dropped.
export function createDedupe(limit = 20) {
  const seen: string[] = [];
  return (id: string | null): boolean => {
    if (!id) return true;
    if (seen.includes(id)) return false;
    seen.push(id);
    if (seen.length > limit) seen.shift();
    return true;
  };
}

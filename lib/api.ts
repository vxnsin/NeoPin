export type User = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin?: boolean;
};

export type ServerStatus = { version: string; registrationOpen: boolean };

export type DeviceAuth = { serverIp: string; deviceId: string; token: string };

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

// "192.168.1.20:3012" is what people type, the socket needs a scheme.
export function normalizeServerUrl(input: string): string {
  const url = input.trim();
  return /^wss?:\/\//i.test(url) ? url : `ws://${url}`;
}

// The login stores the socket address. The HTTP routes live on the same host and path.
export function httpBase(socketUrl: string): string {
  return socketUrl
    .trim()
    .replace(/^ws(s?):\/\//i, (_, secure) => (secure ? "https://" : "http://"))
    .replace(/\/+$/, "");
}

// Header values have to stay ASCII, device names like "Luis’ iPhone" do not.
// The server decodes both.
export function deviceHeaders(auth: Pick<DeviceAuth, "deviceId" | "token">): Record<string, string> {
  return {
    "X-Device-Id": encodeURIComponent(auth.deviceId),
    Authorization: `Bearer ${encodeURIComponent(auth.token)}`,
  };
}

// The server answers errors as problem JSON, the message is meant for people.
export async function problemText(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    const text = body?.message ?? body?.detail ?? body?.title;
    if (typeof text === "string" && text) return text;
  } catch {
    // not JSON
  }
  return fallback;
}

export function defaultProblem(status: number): string {
  switch (status) {
    case 401:
      return "The server did not accept the login.";
    case 403:
      return "The server refused this request.";
    case 404:
      return "Not found on this server.";
    case 429:
      return "Too many attempts. Wait a minute.";
    default:
      return `The server answered with ${status}.`;
  }
}

async function request(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    const aborted = error?.name === "AbortError";
    throw new ApiError(aborted ? "The server took too long to answer." : "Could not reach the server.", 0);
  } finally {
    clearTimeout(timer);
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new ApiError(await problemText(response, defaultProblem(response.status)), response.status);
  return (await response.json()) as T;
}

export async function fetchStatus(serverUrl: string): Promise<ServerStatus> {
  return json<ServerStatus>(await request(`${httpBase(serverUrl)}/api/status`, {}, 5_000));
}

export async function loginRequest(
  serverUrl: string,
  body: { username: string; password: string; deviceId: string }
): Promise<{ token: string; user: User }> {
  return json(
    await request(`${httpBase(serverUrl)}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

// Best effort: the token is dropped locally either way.
export async function logoutRequest(auth: DeviceAuth): Promise<void> {
  try {
    await request(`${httpBase(auth.serverIp)}/api/auth/logout`, { method: "POST", headers: deviceHeaders(auth) }, 4_000);
  } catch {
    // offline or server gone
  }
}

export async function fetchMe(auth: DeviceAuth): Promise<User> {
  return json(await request(`${httpBase(auth.serverIp)}/api/me`, { headers: deviceHeaders(auth) }));
}

export type Visit = {
  type: "visit";
  start: number;
  end: number;
  durationMs: number;
  lat: number;
  lon: number;
  pointCount: number;
};

export type TripMode = "walking" | "cycling" | "driving";

export type Trip = {
  type: "trip";
  start: number;
  end: number;
  durationMs: number;
  distanceM: number;
  mode: TripMode;
  path: [number, number][];
};

export type Segment = Visit | Trip;

export type Timeline = {
  date: string;
  deviceId: string;
  summary: { visits: number; distanceM: number; movingMs: number; pointCount: number };
  segments: Segment[];
};

export type AccountSummary = User & { devices: number };

export type AccountDevice = {
  deviceId: string;
  linkedAt?: string | null;
  status: "online" | "offline";
  lastPing: string | null;
  position: { latitude: number; longitude: number } | null;
};

// Admin only.
export async function fetchUsers(auth: DeviceAuth): Promise<AccountSummary[]> {
  return json(await request(`${httpBase(auth.serverIp)}/api/users`, { headers: deviceHeaders(auth) }));
}

export async function fetchUserDevices(auth: DeviceAuth, userId: number): Promise<AccountDevice[]> {
  return json(await request(`${httpBase(auth.serverIp)}/api/users/${userId}/devices`, { headers: deviceHeaders(auth) }));
}

// userId is for admins who look at another account.
const timelineQuery = (deviceId: string, userId?: number) =>
  `deviceId=${encodeURIComponent(deviceId)}${userId === undefined ? "" : `&userId=${userId}`}&tz=${new Date().getTimezoneOffset()}`;

export async function fetchTimeline(auth: DeviceAuth, deviceId: string, date: string, userId?: number): Promise<Timeline> {
  const query = `${timelineQuery(deviceId, userId)}&date=${date}`;
  return json(await request(`${httpBase(auth.serverIp)}/api/timeline?${query}`, { headers: deviceHeaders(auth) }));
}

export async function fetchTimelineDays(auth: DeviceAuth, deviceId: string, userId?: number): Promise<string[]> {
  return json(
    await request(`${httpBase(auth.serverIp)}/api/timeline/days?${timelineQuery(deviceId, userId)}`, { headers: deviceHeaders(auth) })
  );
}

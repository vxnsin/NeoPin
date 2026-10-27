import type { DeviceType } from "@/lib/devices";

export type User = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin?: boolean;
  mustChangePassword?: boolean;
};

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
// Accepts what people paste: ws(s)://, http(s)://, or a bare address. A bare name
// without a port ("neopin.example.com") is a public host behind TLS, an IP or a
// host with a port ("192.168.2.128:3012") is a local one.
export function normalizeServerUrl(input: string): string {
  const url = input.trim().replace(/\/+$/, "");
  if (/^wss?:\/\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url.replace(/^http/i, "ws");
  const local = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(url) || /:\d+$/.test(url);
  return `${local ? "ws" : "wss"}://${url}`;
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

export async function loginRequest(
  serverUrl: string,
  body: { username: string; password: string; deviceId: string; deviceType?: DeviceType }
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

// Revokes the old token of this device and answers with a fresh one.
export async function changePasswordRequest(
  auth: DeviceAuth,
  currentPassword: string,
  newPassword: string
): Promise<{ message: string; token: string }> {
  return json(
    await request(`${httpBase(auth.serverIp)}/api/me/password`, {
      method: "POST",
      headers: { ...deviceHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
  );
}

export async function updateProfileRequest(
  auth: DeviceAuth,
  changes: { displayName?: string; username?: string }
): Promise<User> {
  return json(
    await request(`${httpBase(auth.serverIp)}/api/me`, {
      method: "PATCH",
      headers: { ...deviceHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    })
  );
}

// Picks the device that stands for your account, null goes back to the automatic choice.
export async function setPrimaryDeviceRequest(auth: DeviceAuth, deviceId: string | null): Promise<User> {
  return json(
    await request(`${httpBase(auth.serverIp)}/api/me/primary-device`, {
      method: "PUT",
      headers: { ...deviceHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    })
  );
}

export async function fetchMe(auth: DeviceAuth): Promise<User> {
  return json(await request(`${httpBase(auth.serverIp)}/api/me`, { headers: deviceHeaders(auth) }));
}

export type PlaceKind =
  | "home"
  | "work"
  | "cafe"
  | "restaurant"
  | "bar"
  | "grocery"
  | "shop"
  | "station"
  | "school"
  | "health"
  | "sport"
  | "park"
  | "culture"
  | "hotel"
  | "worship"
  | "fuel"
  | "building"
  | "place";

// Where a visit was: an own place (named or confirmed) or a guess from OpenStreetMap.
export type VisitPlace = { id: number | null; name: string; kind: PlaceKind; source: "own" | "osm"; osmId: string | null };

export type PlaceChoice = VisitPlace & { distanceM: number };

export type Visit = {
  type: "visit";
  start: number;
  end: number;
  durationMs: number;
  lat: number;
  lon: number;
  pointCount: number;
  // Servers from before place names leave it out.
  place?: VisitPlace | null;
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
  // Some place names are still being looked up, asking again in a few seconds has them.
  placesPending?: boolean;
};

export type AccountSummary = User & { devices: number };

export type AccountDevice = {
  deviceId: string;
  linkedAt?: string | null;
  deviceType?: DeviceType;
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

const forUser = (userId?: number) => (userId === undefined ? "" : `userId=${userId}`);

// What a visit could have been: own places close by first, then OpenStreetMap, nearest first.
export async function fetchPlaceChoices(auth: DeviceAuth, lat: number, lon: number, userId?: number): Promise<PlaceChoice[]> {
  const query = [`lat=${lat}`, `lon=${lon}`, forUser(userId)].filter(Boolean).join("&");
  return json(await request(`${httpBase(auth.serverIp)}/api/places/nearby?${query}`, { headers: deviceHeaders(auth) }));
}

export type PlaceInput = { lat: number; lon: number; name: string; kind?: PlaceKind; osmId?: string | null };

// "I was here": names the spot. An own place that already covers it is corrected.
export async function savePlaceAt(auth: DeviceAuth, place: PlaceInput, userId?: number): Promise<void> {
  const { osmId, ...rest } = place;
  await json(
    await request(`${httpBase(auth.serverIp)}/api/places?${forUser(userId)}`, {
      method: "POST",
      headers: { ...deviceHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify({ ...rest, ...(osmId && { osmId }) }),
    })
  );
}

// Picking an own place for a visit: the spot belongs to it from now on. The server grows it
// to reach the spot and makes closer own places let go of it.
export async function claimPlace(auth: DeviceAuth, id: number, lat: number, lon: number, userId?: number): Promise<void> {
  await json(
    await request(`${httpBase(auth.serverIp)}/api/places/${id}/claim?${forUser(userId)}`, {
      method: "POST",
      headers: { ...deviceHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon }),
    })
  );
}

export type GroupMember = { id: number; username: string; displayName: string; avatarUrl: string | null; role: "owner" | "member" };

export type Group = {
  id: number;
  name: string;
  ownerId: number;
  role: "owner" | "member";
  canManage: boolean;
  members: GroupMember[];
  // Only managers get these.
  pendingInvites?: { id: number; user: { id: number; username: string; displayName: string } }[];
};

export type Invite = {
  id: number;
  groupId: number;
  groupName: string;
  invitedBy: { id: number; username: string; displayName: string };
  createdAt: string;
};

async function noContent(response: Response): Promise<void> {
  if (!response.ok) throw new ApiError(await problemText(response, defaultProblem(response.status)), response.status);
}

const api = (auth: DeviceAuth, path: string) => `${httpBase(auth.serverIp)}/api${path}`;

const jsonInit = (auth: DeviceAuth, method: string, body?: unknown): RequestInit => ({
  method,
  headers: { ...deviceHeaders(auth), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function fetchGroups(auth: DeviceAuth): Promise<Group[]> {
  return json(await request(api(auth, "/groups"), jsonInit(auth, "GET")));
}

export async function fetchInvites(auth: DeviceAuth): Promise<Invite[]> {
  return json(await request(api(auth, "/invites"), jsonInit(auth, "GET")));
}

export async function createGroup(auth: DeviceAuth, name: string): Promise<void> {
  await json(await request(api(auth, "/groups"), jsonInit(auth, "POST", { name })));
}

export async function renameGroup(auth: DeviceAuth, id: number, name: string): Promise<void> {
  await json(await request(api(auth, `/groups/${id}`), jsonInit(auth, "PATCH", { name })));
}

export async function deleteGroup(auth: DeviceAuth, id: number): Promise<void> {
  await noContent(await request(api(auth, `/groups/${id}`), jsonInit(auth, "DELETE")));
}

export async function inviteToGroup(auth: DeviceAuth, id: number, username: string): Promise<void> {
  await json(await request(api(auth, `/groups/${id}/invites`), jsonInit(auth, "POST", { username })));
}

export async function cancelInvite(auth: DeviceAuth, groupId: number, inviteId: number): Promise<void> {
  await noContent(await request(api(auth, `/groups/${groupId}/invites/${inviteId}`), jsonInit(auth, "DELETE")));
}

// The owner removes someone, anyone leaves themself with their own id.
export async function removeMember(auth: DeviceAuth, groupId: number, userId: number): Promise<void> {
  await noContent(await request(api(auth, `/groups/${groupId}/members/${userId}`), jsonInit(auth, "DELETE")));
}

export async function answerInvite(auth: DeviceAuth, inviteId: number, accept: boolean): Promise<void> {
  await noContent(await request(api(auth, `/invites/${inviteId}/${accept ? "accept" : "decline"}`), jsonInit(auth, "POST")));
}

export type FoundUser = { id: number; username: string; displayName: string; avatarUrl: string | null };

// People to invite: matches by username or name, without the caller and, with groupId, without members.
export async function searchUsers(auth: DeviceAuth, query: string, groupId?: number): Promise<FoundUser[]> {
  const params = `q=${encodeURIComponent(query)}${groupId === undefined ? "" : `&groupId=${groupId}`}`;
  return json(await request(api(auth, `/users/search?${params}`), jsonInit(auth, "GET")));
}

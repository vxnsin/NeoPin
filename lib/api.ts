import type { DeviceType } from "@/lib/devices";

export type User = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin?: boolean;
  mustChangePassword?: boolean;
  // Only on the own account, from servers that can hide: until when (ms), null when visible.
  hiddenUntil?: number | null;
  // The device picked to stand for the account, null for automatic. Older logins have none stored.
  primaryDeviceId?: string | null;
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

// Asks one device for a fresh position. True when the server could reach it; the position itself
// arrives over the socket. A device that is not connected is a 404 from the server.
export async function pingDeviceRequest(auth: DeviceAuth, deviceId: string, userId?: number): Promise<boolean> {
  const response = await request(`${httpBase(auth.serverIp)}/api/sendPing`, {
    method: "POST",
    headers: { ...deviceHeaders(auth), "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, userId }),
  });
  if (response.status === 202) return false;
  await json(response);
  return true;
}

export async function fetchMe(auth: DeviceAuth): Promise<User> {
  return json(await request(`${httpBase(auth.serverIp)}/api/me`, { headers: deviceHeaders(auth) }));
}

// Gone from everyone else's map for this many minutes, or until turned off (null).
export async function setHidden(auth: DeviceAuth, minutes: number | null): Promise<User> {
  return json(
    await request(`${httpBase(auth.serverIp)}/api/me/hidden`, {
      method: "PUT",
      headers: { ...deviceHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify(minutes === null ? {} : { minutes }),
    })
  );
}

export async function showMe(auth: DeviceAuth): Promise<User> {
  return json(await request(`${httpBase(auth.serverIp)}/api/me/hidden`, { method: "DELETE", headers: deviceHeaders(auth) }));
}

export type ServerStatus = { version: string; commit?: string | null; builtAt?: string | null };

// Which server build runs. Older servers only know their version.
export async function fetchServerStatus(serverIp: string): Promise<ServerStatus> {
  return json(await request(`${httpBase(serverIp)}/api/status`));
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

export type TripMode = "walking" | "cycling" | "driving" | "transit";

export type TransitKind = "bus" | "tram" | "subway" | "train" | "ferry";

export type TransitStop = { name: string; lat: number; lon: number };

// A ride the server matched to a line: from timetable data (gtfs) or OpenStreetMap routes (osm).
export type TransitInfo = {
  kind: TransitKind;
  line: string;
  headsign: string | null;
  // The line's own colours, null when the feed has none.
  color: string | null;
  textColor: string | null;
  agency: string | null;
  from: TransitStop;
  to: TransitStop;
  source: "gtfs" | "osm";
};

export type Trip = {
  type: "trip";
  start: number;
  end: number;
  durationMs: number;
  distanceM: number;
  mode: TripMode;
  path: [number, number][];
  // No fixes on the way, only where it started and ended is known.
  gap?: boolean;
  // Only with mode "transit", and even then missing when no line could be matched.
  transit?: TransitInfo | null;
};

// What a trip is corrected to; "auto" drops the correction and the server guesses again.
export type TripModeChoice = TripMode | "auto";

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

// Without a name the server names Home and Work itself ("Home", "Home 2", "Work");
// any other kind without a name is a 400 (name-required).
export type PlaceInput = { lat: number; lon: number; name?: string; kind?: PlaceKind; osmId?: string | null };

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

// "This was: Transit". The server keeps the correction per account, device and start time of the trip.
export async function setTripMode(auth: DeviceAuth, deviceId: string, start: number, mode: TripModeChoice): Promise<void> {
  await noContent(
    await request(`${httpBase(auth.serverIp)}/api/trips/mode`, {
      method: "PUT",
      headers: { ...deviceHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, start, mode }),
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
  // Holds everyone for good: no leaving, removing, inviting or deleting. Older servers leave it out.
  fixed?: boolean;
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

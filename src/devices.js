import { getUser, inferDeviceType, isHidden, linkedDevices, listUsers, publicUser } from "./accounts.js";
import { lastPosition } from "./history.js";
import { sharedGroupIds, visibleUserIds } from "./groups.js";
import { config } from "./config.js";

// In-memory device registry. A device belongs to one account and is known by that
// account and its name, so two people may both own an "iPhone". A record outlives
// its socket, so a reconnecting device keeps its last position and shows as online again.

const devices = new Map();

const keyOf = (userId, deviceId) => `${userId}:${deviceId}`;

export function getDevice(userId, deviceId) {
  return devices.get(keyOf(userId, deviceId));
}

export function allDevices(userId) {
  const all = Array.from(devices.values());
  return userId === undefined ? all : all.filter((d) => d.userId === userId);
}

export function onlineDevices(userId) {
  return allDevices(userId).filter((d) => d.status === "online" && d.socket);
}

// Online while the socket is open, and after it closed for two report periods: a phone
// whose foreground service is gone (its notification swiped away on Android) still
// reports through short visits of its background task, and is not offline in between.
export function statusOf(device, now = Date.now()) {
  if (!device) return "offline";
  if (device.socket) return "online";
  if (!device.lastPing) return "offline";
  const { minMs, slackMs, defaultIntervalMs } = config.onlineGrace;
  const grace = Math.max(minMs, 2 * (device.intervalMs ?? defaultIntervalMs) + slackMs);
  return now - Date.parse(device.lastPing) <= grace ? "online" : "offline";
}

// Registers a socket for a device and returns the socket it replaces, if any.
// intervalMs is how often the app means to report, from its update preset.
export function attachSocket(userId, deviceId, socket, deviceType, intervalMs) {
  const key = keyOf(userId, deviceId);
  let device = devices.get(key);
  if (!device) {
    device = { id: deviceId, userId, socket: null, position: null, lastPing: null, status: "offline", deviceType: null };
    devices.set(key, device);
  }
  const previous = device.socket;
  device.socket = socket;
  device.status = "online";
  if (deviceType) device.deviceType = deviceType;
  if (intervalMs) device.intervalMs = intervalMs;
  return previous && previous !== socket ? previous : null;
}

// Marks a device offline, but only if the closing socket is still the active one.
export function detachSocket(userId, deviceId, socket) {
  const device = devices.get(keyOf(userId, deviceId));
  if (!device || device.socket !== socket) return false;
  device.socket = null;
  device.status = "offline";
  return true;
}

export function updatePosition(userId, deviceId, latitude, longitude) {
  const device = devices.get(keyOf(userId, deviceId));
  if (!device) return null;
  device.position = { latitude, longitude };
  device.lastPing = new Date().toISOString();
  return device;
}

// The charge the app last reported, 0 to 100. Kept in memory only: after a restart
// the next report fills it in again.
export function updateBattery(userId, deviceId, level, charging) {
  const device = devices.get(keyOf(userId, deviceId));
  if (!device) return null;
  device.battery = { level, charging, updatedAt: new Date().toISOString() };
  return device;
}

// Everyone signed in sees every device. The picture and the name belong to the
// account that owns the device, so all devices of one person look alike.
// The list is built from the linked devices in the database, so it survives a server
// restart: a device that has not connected yet shows as offline with its last stored
// position. A device whose login was revoked is gone unless it is still connected.
export function serializeDevices(viewer) {
  const rows = new Map();
  // A viewer only gets the devices of people they share a group with (the admin gets all).
  const visible = viewer ? visibleUserIds(viewer) : null;
  const groupIds = new Map();
  const groupsOf = (userId) => {
    if (!viewer) return [];
    if (!groupIds.has(userId)) groupIds.set(userId, sharedGroupIds(viewer.id, userId));
    return groupIds.get(userId);
  };

  for (const user of listUsers()) {
    if (visible && !visible.has(user.id)) continue;
    // Someone who hides is gone from the map of everyone else, the admin included.
    if (viewer && user.id !== viewer.id && isHidden(user)) continue;
    const owner = publicUser(user);
    for (const link of linkedDevices(user.id)) {
      const live = devices.get(keyOf(user.id, link.deviceId));
      const stored = live?.position ? null : lastPosition(user.id, link.deviceId);
      rows.set(keyOf(user.id, link.deviceId), {
        deviceId: link.deviceId,
        userId: user.id,
        owner: { username: owner.username, displayName: owner.displayName },
        position: live?.position ?? (stored ? { latitude: stored.lat, longitude: stored.lon } : null),
        lastPing: live?.lastPing ?? (stored ? new Date(stored.ts).toISOString() : null),
        status: statusOf(live),
        battery: live?.battery ?? null,
        avatarUrl: owner.avatarUrl,
        deviceType: live?.deviceType ?? link.deviceType ?? "phone",
        // Picked by the owner to stand for them. The clients still prefer an online device.
        primary: owner.primaryDeviceId === link.deviceId,
        groupIds: groupsOf(user.id),
      });
    }
  }

  // Connected devices without a stored login (should not happen, but never hide a live one).
  for (const d of allDevices()) {
    if (d.status !== "online" || rows.has(keyOf(d.userId, d.id)) || (visible && !visible.has(d.userId))) continue;
    const owner = publicUser(getUser(d.userId));
    rows.set(keyOf(d.userId, d.id), {
      deviceId: d.id,
      userId: d.userId,
      owner: { username: owner?.username ?? "", displayName: owner?.displayName ?? "" },
      position: d.position,
      lastPing: d.lastPing,
      status: statusOf(d),
      battery: d.battery ?? null,
      avatarUrl: owner?.avatarUrl ?? null,
      deviceType: d.deviceType ?? inferDeviceType(d.id),
      primary: owner?.primaryDeviceId === d.id,
      groupIds: groupsOf(d.userId),
    });
  }
  return [...rows.values()];
}

export function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  const units = [
    [31536000, "year"],
    [2592000, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const value = Math.floor(seconds / size);
      return `${value} ${name}${value === 1 ? "" : "s"} ago`;
    }
  }
  return `${seconds} seconds ago`;
}

export function removeDevice(userId, deviceId) {
  devices.delete(keyOf(userId, deviceId));
}

export function resetDevices() {
  devices.clear();
}

import { getUser, inferDeviceType, linkedDevices, listUsers, publicUser } from "./accounts.js";
import { lastPosition } from "./history.js";
import { sharedGroupIds, visibleUserIds } from "./groups.js";

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

// Registers a socket for a device and returns the socket it replaces, if any.
export function attachSocket(userId, deviceId, socket, deviceType) {
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
        status: live?.status ?? "offline",
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
      status: d.status,
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

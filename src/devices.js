import { getUser, publicUser } from "./accounts.js";

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
export function attachSocket(userId, deviceId, socket) {
  const key = keyOf(userId, deviceId);
  let device = devices.get(key);
  if (!device) {
    device = { id: deviceId, userId, socket: null, position: null, lastPing: null, status: "offline" };
    devices.set(key, device);
  }
  const previous = device.socket;
  device.socket = socket;
  device.status = "online";
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

// Everyone signed in sees every device. The picture and the name belong to the
// account that owns the device, so all devices of one person look alike.
export function serializeDevices() {
  const owners = new Map();
  const ownerOf = (userId) => {
    if (!owners.has(userId)) owners.set(userId, publicUser(getUser(userId)));
    return owners.get(userId);
  };
  return allDevices().map((d) => {
    const owner = ownerOf(d.userId);
    return {
      deviceId: d.id,
      userId: d.userId,
      owner: { username: owner?.username ?? "", displayName: owner?.displayName ?? "" },
      position: d.position,
      lastPing: d.lastPing,
      status: d.status,
      avatarUrl: owner?.avatarUrl ?? null,
    };
  });
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

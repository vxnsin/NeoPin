import crypto from "crypto";

// In-memory device registry. A device record outlives its socket, so a
// reconnecting device keeps its last position and shows as online again.

const devices = new Map();

export function getDevice(deviceId) {
  return devices.get(deviceId);
}

export function allDevices() {
  return Array.from(devices.values());
}

export function onlineDevices() {
  return allDevices().filter((d) => d.status === "online" && d.socket);
}

// Registers a socket for a device and returns the socket it replaces, if any.
export function attachSocket(deviceId, socket) {
  let device = devices.get(deviceId);
  if (!device) {
    device = { id: deviceId, socket: null, position: null, lastPing: null, status: "offline", avatar: null };
    devices.set(deviceId, device);
  }
  const previous = device.socket;
  device.socket = socket;
  device.status = "online";
  return previous && previous !== socket ? previous : null;
}

// Marks a device offline, but only if the closing socket is still the active one.
export function detachSocket(deviceId, socket) {
  const device = devices.get(deviceId);
  if (!device || device.socket !== socket) return false;
  device.socket = null;
  device.status = "offline";
  return true;
}

export function updatePosition(deviceId, latitude, longitude) {
  const device = devices.get(deviceId);
  if (!device) return null;
  device.position = { latitude, longitude };
  device.lastPing = new Date().toISOString();
  return device;
}

// Pictures live in memory like everything else. The version is part of the URL,
// so browsers may cache a picture for good and still see a new one right away.
export function setAvatar(deviceId, data, type) {
  const device = devices.get(deviceId);
  if (!device) return null;
  const version = crypto.createHash("sha256").update(data).digest("base64url").slice(0, 12);
  device.avatar = { data, type, version };
  return device;
}

export function clearAvatar(deviceId) {
  const device = devices.get(deviceId);
  if (!device) return null;
  device.avatar = null;
  return device;
}

export function avatarUrl(device) {
  if (!device?.avatar) return null;
  return `/avatars/${encodeURIComponent(device.id)}?v=${device.avatar.version}`;
}

export function serializeDevices() {
  return allDevices().map((d) => ({
    deviceId: d.id,
    position: d.position,
    lastPing: d.lastPing,
    status: d.status,
    avatarUrl: avatarUrl(d),
  }));
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

export function resetDevices() {
  devices.clear();
}

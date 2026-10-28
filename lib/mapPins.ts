import { deviceKey, groupPeople, type Device } from "@/lib/devices";

export type PinKind = "avatar" | "chip" | "hidden";

// One avatar per person on the map: their primary device, the same pick the people list makes.
// The rest of their devices become small chips while they are online and stay off the map while
// they are offline. Three avatars of one person told apart only by a tiny badge were confusing.
export function pinKinds(devices: Device[]): Map<string, PinKind> {
  const kinds = new Map<string, PinKind>();
  for (const person of groupPeople(devices)) {
    person.devices.forEach((device, index) => {
      kinds.set(deviceKey(device), index === 0 ? "avatar" : device.status === "online" ? "chip" : "hidden");
    });
  }
  return kinds;
}

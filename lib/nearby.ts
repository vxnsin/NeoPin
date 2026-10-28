import { PermissionsAndroid, Platform } from "react-native";
import { NearbyNative, type NearbyRadioState, type NearbySighting } from "../modules/neopin-nearby";

// Bluetooth for the last metres of a find. GPS cannot tell ten metres from two, the strength of
// the other phone's signal can, roughly: it says how close, never which way.

export type NearbyState = NearbyRadioState | "unavailable";

// The session id is 9 random bytes, base64url. With a fixed tail it makes the UUID both phones
// send out and listen for, so no name and no account ever goes over the air.
const TAIL = [0x6e, 0x65, 0x6f, 0x70, 0x69, 0x6e, 0x21]; // "neopin!"
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64urlBytes(text: string): number[] {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const n = B64.indexOf(ch);
    if (n < 0) continue;
    value = ((value << 6) | n) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return out;
}

export function sessionUuid(session: string): string {
  const bytes = base64urlBytes(session).slice(0, 9);
  while (bytes.length < 9) bytes.push(0);
  const hex = [...bytes, ...TAIL].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// How strong the other phone comes in, dBm. Phones in pockets and hands eat a lot of signal,
// so the steps are generous.
export type SignalBand = "here" | "very-close" | "close" | "around";
export const HERE_DBM = -62;
export const VERY_CLOSE_DBM = -72;
export const CLOSE_DBM = -84;
// A signal older than this is gone: the other phone moved out of reach or Bluetooth went off.
export const LOST_MS = 8_000;
// Right next to each other for this long: they met.
export const MET_MS = 3_000;

export function signalBand(rssi: number): SignalBand {
  if (rssi > HERE_DBM) return "here";
  if (rssi > VERY_CLOSE_DBM) return "very-close";
  if (rssi > CLOSE_DBM) return "close";
  return "around";
}

export type NearbyReading = { band: SignalBand; rssi: number; at: number };

// Readings jump around by 10 dBm from one to the next, so the last few are averaged, newer
// ones counting more.
export class SignalTracker {
  private smoothed: number | null = null;
  private lastAt = 0;
  private hereSince: number | null = null;

  add({ rssi, at }: NearbySighting): NearbyReading {
    this.smoothed = this.smoothed === null ? rssi : this.smoothed * 0.6 + rssi * 0.4;
    this.lastAt = at;
    const band = signalBand(this.smoothed);
    this.hereSince = band === "here" ? (this.hereSince ?? at) : null;
    return { band, rssi: Math.round(this.smoothed), at };
  }

  reading(now: number): NearbyReading | null {
    if (this.smoothed === null || now - this.lastAt > LOST_MS) return null;
    return { band: signalBand(this.smoothed), rssi: Math.round(this.smoothed), at: this.lastAt };
  }

  met(now: number): boolean {
    return this.hereSince !== null && now - this.hereSince >= MET_MS && now - this.lastAt <= LOST_MS;
  }
}

export function nearbyText(band: SignalBand): string {
  switch (band) {
    case "here":
      return "Right here";
    case "very-close":
      return "Very close";
    case "close":
      return "Close";
    default:
      return "Somewhere around";
  }
}

// What to tell when Bluetooth cannot help, null when it works or the build has no Bluetooth.
export function nearbyHint(state: NearbyState): string | null {
  switch (state) {
    case "off":
      return "Turn on Bluetooth, it helps on the last metres.";
    case "unauthorized":
      return "Allow Bluetooth for NeoPin in the settings, it helps on the last metres.";
    case "failed":
      return "Bluetooth is not working right now.";
    default:
      return null;
  }
}

export const nearbyAvailable = () => NearbyNative !== null;

// Android 12 and newer ask for Bluetooth on their own, older versions scan with the location
// permission the app already has. iOS asks the first time the radio starts.
export async function nearbyPermission(): Promise<boolean> {
  if (Platform.OS !== "android" || Number(Platform.Version) < 31) return true;
  const wanted = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  ];
  try {
    const result = await PermissionsAndroid.requestMultiple(wanted);
    return wanted.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}

// Runs the radio for one find session. Readings come smoothed, onState tells when Bluetooth
// cannot help. The returned function stops everything.
export function startNearby(
  session: string,
  onReading: (reading: NearbyReading, met: boolean) => void,
  onState: (state: NearbyState) => void
): () => void {
  const native = NearbyNative;
  if (!native) {
    onState("unavailable");
    return () => {};
  }
  const tracker = new SignalTracker();
  let stopped = false;
  const sightings = native.addListener("onSighting", (sighting) => {
    if (stopped) return;
    const reading = tracker.add(sighting);
    onReading(reading, tracker.met(sighting.at));
  });
  const states = native.addListener("onState", ({ state }) => {
    if (!stopped) onState(state);
  });
  nearbyPermission()
    .then((granted) => (granted ? native.start(sessionUuid(session)) : "unauthorized"))
    .then((state) => {
      if (stopped) native.stop().catch(() => {});
      else onState(state);
    })
    .catch(() => !stopped && onState("failed"));
  return () => {
    stopped = true;
    sightings.remove();
    states.remove();
    native.stop().catch(() => {});
  };
}

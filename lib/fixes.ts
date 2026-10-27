import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LocationObject } from "expo-location";
import type { Message } from "./SocketClient";

// One GPS fix as the server takes it. recordedAt is when the phone took it, so a fix
// sent later still lands at the right time in the timeline.
export type Fix = { latitude: number; longitude: number; recordedAt?: number; accuracy?: number; speed?: number };

// The server closes the socket on values outside these, so those are left out.
const MAX_ACCURACY_M = 100_000;
const MAX_SPEED_MS = 200;

export function toFix(location: LocationObject): Fix {
  const { latitude, longitude, accuracy, speed } = location.coords;
  return {
    latitude,
    longitude,
    ...(location.timestamp > 0 && { recordedAt: Math.round(location.timestamp) }),
    // iOS reports -1 when it does not know.
    ...(accuracy != null && accuracy >= 0 && accuracy <= MAX_ACCURACY_M && { accuracy }),
    ...(speed != null && speed >= 0 && speed <= MAX_SPEED_MS && { speed }),
  };
}

export function distanceM(a: Fix, b: Fix): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Servers that can take fixes collected offline say so in their login reply.
export const BATCH_FEATURE = "positionBatch";
const BATCH_SIZE = 100;

// What goes out for the fixes of one report: the older ones as batches (history only),
// the newest as a normal update so the map moves. Servers without batches only get
// the newest, as before.
export function reportMessages(older: Fix[], latest: Message | null, features: readonly string[]): Message[] {
  const messages: Message[] = [];
  if (features.includes(BATCH_FEATURE)) {
    for (let i = 0; i < older.length; i += BATCH_SIZE) {
      messages.push({ type: "positionBatch", points: older.slice(i, i + BATCH_SIZE) });
    }
  }
  if (latest) messages.push(latest);
  return messages;
}

// Fixes taken without a connection (a dead spot, flight mode) are kept on the phone
// until the next connection, a few days worth at most.
const HELD_KEY = "neopin.heldFixes";
const MAX_HELD = 5_000;

// The background task and the app run in the same JavaScript, one change at a time.
let pending: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = pending.then(fn, fn);
  pending = run.catch(() => {});
  return run;
}

async function readHeld(): Promise<Fix[]> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(HELD_KEY)) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function holdFixes(fixes: Fix[]): Promise<void> {
  if (fixes.length === 0) return Promise.resolve();
  return serial(async () => {
    const held = [...(await readHeld()), ...fixes]
      .sort((a, b) => (a.recordedAt ?? 0) - (b.recordedAt ?? 0))
      .slice(-MAX_HELD);
    await AsyncStorage.setItem(HELD_KEY, JSON.stringify(held));
  });
}

// Hands out everything held and forgets it. Whoever takes it sends it or holds it again.
export function takeHeldFixes(): Promise<Fix[]> {
  return serial(async () => {
    const held = await readHeld();
    if (held.length) await AsyncStorage.removeItem(HELD_KEY);
    return held;
  });
}

// On logout: those fixes belong to the old login.
export function clearHeldFixes(): Promise<void> {
  return serial(() => AsyncStorage.removeItem(HELD_KEY));
}

type Target = { emit: (msg: Message) => void; features: readonly string[] };

// Once the socket is back, what was held goes out. A server without batches cannot
// store it, those fixes are dropped instead of piling up.
export async function sendHeldFixes(target: Target) {
  const held = await takeHeldFixes();
  reportMessages(held, null, target.features).forEach((msg) => target.emit(msg));
}

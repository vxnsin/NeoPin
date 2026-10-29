import AsyncStorage from "@react-native-async-storage/async-storage";
import { rememberOnce, type RideQuestion } from "@/lib/rides";

const ASKED_KEY = "neopin.ridesAsked";
const ANSWERED_KEY = "neopin.ridesAnswered";

// The ids live in memory for the running app and in storage for the background task, which may run
// in a JS instance of its own. Memory is checked first, so two calls at once cannot both pass.
const memory: Record<string, Set<string>> = { [ASKED_KEY]: new Set(), [ANSWERED_KEY]: new Set() };

async function firstTime(key: string, id: string): Promise<boolean> {
  if (memory[key].has(id)) return false;
  memory[key].add(id);
  try {
    const raw = await AsyncStorage.getItem(key);
    const seen = raw ? (JSON.parse(raw) as string[]) : [];
    const { fresh, seen: next } = rememberOnce(Array.isArray(seen) ? seen : [], id);
    if (fresh) await AsyncStorage.setItem(key, JSON.stringify(next));
    return fresh;
  } catch {
    // Without storage the memory still keeps it to once per run.
    return true;
  }
}

async function forget(key: string, id: string) {
  memory[key].delete(id);
  try {
    const raw = await AsyncStorage.getItem(key);
    const seen = raw ? (JSON.parse(raw) as string[]) : [];
    if (Array.isArray(seen)) await AsyncStorage.setItem(key, JSON.stringify(seen.filter((value) => value !== id)));
  } catch {
    // nothing stored to take back
  }
}

// True the first time a ride comes up, false for every repeat of the same rideId.
export function firstAsk(rideId: string): Promise<boolean> {
  return firstTime(ASKED_KEY, rideId);
}

// An answer goes to the server once, even when the button reaches both the task and the app.
export function firstAnswer(rideId: string): Promise<boolean> {
  return firstTime(ANSWERED_KEY, rideId);
}

// A failed answer may be given again.
export function forgetAnswer(rideId: string): Promise<void> {
  return forget(ANSWERED_KEY, rideId);
}

export async function wasAnswered(rideId: string): Promise<boolean> {
  if (memory[ANSWERED_KEY].has(rideId)) return true;
  try {
    const raw = await AsyncStorage.getItem(ANSWERED_KEY);
    return raw ? (JSON.parse(raw) as string[]).includes(rideId) : false;
  } catch {
    return false;
  }
}

// The map screen shows the question. It may not be mounted yet (cold start from a notification), so the
// question waits here until it takes it.
let waiting: RideQuestion | null = null;
const listeners = new Set<(question: RideQuestion) => void>();

export function showRide(question: RideQuestion) {
  waiting = question;
  listeners.forEach((listener) => listener(question));
}

export function takeRide(): RideQuestion | null {
  const question = waiting;
  waiting = null;
  return question;
}

export function onRide(listener: (question: RideQuestion) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A question from the socket or a push while the app is open: shown once per ride.
export async function offerRide(question: RideQuestion): Promise<void> {
  if (await firstAsk(question.rideId)) showRide(question);
}

import AsyncStorage from "@react-native-async-storage/async-storage";
import { isStaleRide, rememberOnce, stampRide, type RideAnswer, type RideQuestion } from "@/lib/rides";

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

// True the first time a ride comes up, false for every repeat of the same rideId.
export function firstAsk(rideId: string): Promise<boolean> {
  return firstTime(ASKED_KEY, rideId);
}

// An answer the server took. The answer may still be changed; this only keeps a tap on an old
// notification from asking again.
export async function rememberAnswer(rideId: string): Promise<void> {
  await firstTime(ANSWERED_KEY, rideId);
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

// One answer per ride on its way at a time. The same answer again (the button reaches both the task
// and the app) waits for the one already going out and gets its outcome; another answer goes out
// after it, so the last one given is the one the server keeps.
const inFlight = new Map<string, { answer: RideAnswer; done: Promise<void> }>();

export function answerOnce(rideId: string, answer: RideAnswer, send: () => Promise<void>): Promise<void> {
  const running = inFlight.get(rideId);
  if (running && running.answer === answer) return running.done;
  const before = running ? running.done.catch(() => {}) : Promise.resolve();
  const done = before.then(send);
  const entry = { answer, done };
  inFlight.set(rideId, entry);
  const clear = () => {
    if (inFlight.get(rideId) === entry) inFlight.delete(rideId);
  };
  done.then(clear, clear);
  return done;
}

// The map screen shows the question. It may not be mounted yet (cold start from a notification), so the
// question waits here until it takes it, as long as it is not too old.
let waiting: RideQuestion | null = null;
const listeners = new Set<(question: RideQuestion) => void>();

export function showRide(question: RideQuestion) {
  waiting = question;
  listeners.forEach((listener) => listener(question));
}

export function takeRide(now = Date.now()): RideQuestion | null {
  const question = waiting;
  waiting = null;
  return question && !isStaleRide(question, now) ? question : null;
}

export function onRide(listener: (question: RideQuestion) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A question from the socket or a push while the app is open: shown once per ride, while it is fresh.
export async function offerRide(input: RideQuestion, now = Date.now()): Promise<void> {
  const question = stampRide(input, now);
  if (isStaleRide(question, now)) return;
  if (await firstAsk(question.rideId)) showRide(question);
}

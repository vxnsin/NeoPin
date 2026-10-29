// "Are you on Bus 10 towards Hauptbahnhof?": the question the server asks during a ride, read from the
// socket or a push. Kept free of native modules so it can be tested.
import type { TransitKind } from "@/lib/api";
import { dataOf } from "@/lib/pushPayload";
import { TRANSIT_LABELS } from "@/lib/timeline";

export type RideTransit = {
  kind: TransitKind | null;
  line: string;
  headsign: string | null;
  // "#rrggbb", or null when the line has no colour of its own.
  color: string | null;
  textColor: string | null;
  // Where the ride started, a stop name.
  from: string | null;
};

// `at` is when the ride began, `seenAt` when this app got the question (it travels along in the
// notification, so a tap later still knows how old the question is).
export type RideQuestion = { rideId: string; transit: RideTransit; at: number | null; seenAt?: number };

// A question is only worth asking while the ride may still be going on.
export const RIDE_MAX_AGE_MS = 15 * 60_000;

export type RideAnswer = "yes" | "no";

// The notification's category and its two buttons. No ":" or "-" in the category, Android drops them.
export const RIDE_CATEGORY = "rideQuestion";
export const RIDE_YES = "rideYes";
export const RIDE_NO = "rideNo";

const KINDS: TransitKind[] = ["bus", "tram", "subway", "train", "ferry"];

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// GTFS colours come without the "#".
function hexColor(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw}` : null;
}

// White or black, whichever reads better on the line's colour.
export function readableOn(color: string): string {
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#000000" : "#ffffff";
}

// FCM data values are strings: the transit object arrives as JSON, or its fields flat beside the rest.
function transitOf(data: Record<string, unknown>): Record<string, unknown> | null {
  const nested = asObject(data.transit);
  if (nested) return nested;
  if (typeof data.transit === "string") {
    try {
      const parsed = asObject(JSON.parse(data.transit));
      if (parsed) return parsed;
    } catch {
      // not JSON, fall through to the flat fields
    }
  }
  return data.line !== undefined ? data : null;
}

// Takes the socket message or the data of a push (with `type` or the short `t`). Anything that is not
// a ride question, or has no ride or line to ask about, is null.
export function parseRideQuestion(input: unknown): RideQuestion | null {
  const data = asObject(input);
  if (!data || (data.type ?? data.t) !== "rideQuestion") return null;
  const rideId = text(data.rideId);
  const transit = transitOf(data);
  const line = transit ? text(transit.line) : null;
  if (!rideId || !transit || !line) return null;
  const kind = KINDS.find((k) => k === transit.kind) ?? null;
  const color = hexColor(transit.color);
  const from = text(transit.from) ?? text(asObject(transit.from)?.name);
  const at = Number(data.at);
  const seenAt = Number(data.seenAt);
  return {
    rideId,
    transit: {
      kind,
      line,
      headsign: text(transit.headsign),
      color,
      textColor: hexColor(transit.textColor) ?? (color ? readableOn(color) : null),
      from,
    },
    at: data.at !== undefined && data.at !== null && Number.isFinite(at) ? at : null,
    ...(data.seenAt !== undefined && data.seenAt !== null && Number.isFinite(seenAt) ? { seenAt } : {}),
  };
}

// Notes when the question reached the app, the first time it does.
export function stampRide(question: RideQuestion, now: number): RideQuestion {
  return question.seenAt !== undefined ? question : { ...question, seenAt: now };
}

// Older than 15 minutes since it reached the app (or, without that, since the ride began): not asked any more.
export function isStaleRide(question: RideQuestion, now: number, maxAgeMs = RIDE_MAX_AGE_MS): boolean {
  const since = question.seenAt ?? question.at;
  return since !== null && now - since > maxAgeMs;
}

// "Bus 10" but "RB 53" and "S1": a line that starts with letters already says what it is.
export function rideName(transit: Pick<RideTransit, "kind" | "line">): string {
  const label = transit.kind ? TRANSIT_LABELS[transit.kind] : null;
  return label && /^\d/.test(transit.line) ? `${label} ${transit.line}` : transit.line;
}

export function rideQuestionText(question: RideQuestion): string {
  const { headsign } = question.transit;
  return `Are you on ${rideName(question.transit)}${headsign ? ` towards ${headsign}` : ""}?`;
}

export function rideQuestionDetail(question: RideQuestion): string {
  return question.transit.from ? `Since ${question.transit.from}` : "Your answer puts the line on your timeline.";
}

// The button pressed on the notification, or null for a tap on the notification itself.
export function rideAnswerOf(actionIdentifier: unknown): RideAnswer | null {
  if (actionIdentifier === RIDE_YES) return "yes";
  if (actionIdentifier === RIDE_NO) return "no";
  return null;
}

export type RideResponse = { question: RideQuestion; answer: RideAnswer | null };

// A tap or a button on a ride notification, as the background task or the app's response listener
// gets it. The question comes back from the notification's data.
export function rideResponseOf(payload: unknown): RideResponse | null {
  const root = asObject(payload);
  if (!root || typeof root.actionIdentifier !== "string") return null;
  const question = parseRideQuestion(dataOf(payload));
  return question ? { question, answer: rideAnswerOf(root.actionIdentifier) } : null;
}

// Each ride is asked once: the socket, the push and its background task may all bring the same one.
// Returns whether the id is new and the list to keep, newest last, at most `limit` long.
export function rememberOnce(seen: string[], id: string, limit = 50): { fresh: boolean; seen: string[] } {
  if (seen.includes(id)) return { fresh: false, seen };
  const next = [...seen, id];
  return { fresh: true, seen: next.length > limit ? next.slice(next.length - limit) : next };
}

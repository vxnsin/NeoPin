import AsyncStorage from "@react-native-async-storage/async-storage";
import { distanceM, type Fix } from "./fixes";

// A small log of what the app did, for the diagnostics export in the preview build's developer
// settings (lib/diagnosticsExport). It is kept on the phone only, until someone exports it.
// It never holds a position: a fix is logged as its distance to the previous one. Tokens,
// passwords and coordinates are dropped by key, and scrubbed out of free text.

export type DiagValue = string | number | boolean | null;
export type DiagEvent = { t: number; kind: string } & Record<string, DiagValue>;

export type FixSource = "foreground" | "background" | "still" | "request" | "push";
// live: sent as the position, batch: sent as history, dup: the other path sent it already,
// held: kept on the phone for the next connection.
export type FixOutcome = "live" | "batch" | "dup" | "held";

const STORAGE_KEY = "neopin.diagnostics";
export const MAX_EVENTS = 2_000;
export const MAX_BYTES = 512 * 1024;
const MAX_TEXT = 300;
// Written at most this often, fixes come every few seconds on the precise preset.
const SAVE_DELAY_MS = 20_000;
// A phone slower than this lies still or walks on the spot.
const MOVING_SPEED_MS = 0.5;
const MOVING_DISTANCE_M = 25;

// Keys that may hold a secret or a position. Their values never reach the log.
const DROPPED_KEYS = /^(lat|lng|lon|latitude|longitude|coords?|position|token|password|secret|auth|authorization|cookie|pushToken|deviceToken|serverIp|url)$/i;

// Free text (error messages, close reasons) can carry what the keys above keep out.
export function scrubText(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(token|password|secret|authorization)(["']?\s*[:=]\s*)["']?[^\s"',&}]+/gi, "$1$2[redacted]")
    .replace(/[?&](token|key|auth|password)=[^&\s]+/gi, "?$1=[redacted]")
    .replace(/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g, "[coords]")
    .replace(/\b(lat|latitude|lon|lng|longitude)(["']?\s*[:=]\s*)-?\d+(\.\d+)?/gi, "$1$2[redacted]")
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[redacted]")
    .slice(0, MAX_TEXT);
}

// Only flat, small values, with secrets and positions left out.
export function sanitize(fields: Record<string, unknown>): Record<string, DiagValue> {
  const clean: Record<string, DiagValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (DROPPED_KEYS.test(key) || value === undefined) continue;
    if (value === null || typeof value === "boolean") clean[key] = value;
    else if (typeof value === "number") clean[key] = Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    else if (typeof value === "string") clean[key] = scrubText(value);
    else if (value instanceof Error) clean[key] = scrubText(value.message);
  }
  return clean;
}

// Off until lib/diagnosticsCapture turns it on, which it only does in preview and development
// builds: the store builds keep nothing.
let enabled = false;

export function setDiagnosticsEnabled(on: boolean) {
  enabled = on;
}

export function diagnosticsEnabled(): boolean {
  return enabled;
}

let events: DiagEvent[] = [];
let bytes = 0;
let loaded: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const sizeOf = (event: DiagEvent) => JSON.stringify(event).length + 1;

function trim() {
  while (events.length > MAX_EVENTS || (bytes > MAX_BYTES && events.length > 0)) {
    bytes -= sizeOf(events.shift()!);
  }
}

// What was logged before this start comes first. Called before the first export, or on its own.
export function loadDiagnostics(): Promise<void> {
  loaded ??= (async () => {
    try {
      const parsed = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? "[]");
      if (Array.isArray(parsed)) {
        const earlier = parsed.filter((e) => e && typeof e.t === "number" && typeof e.kind === "string");
        events = [...earlier, ...events].sort((a, b) => a.t - b.t);
        bytes = events.reduce((sum, e) => sum + sizeOf(e), 0);
        trim();
      }
    } catch {
      // a broken log starts over
    }
  })();
  return loaded;
}

// Writes the log a moment after the last change, the background task logs in bursts.
export async function saveDiagnostics(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await loadDiagnostics();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // best effort
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDiagnostics().catch(() => {});
  }, SAVE_DELAY_MS);
}

export function logEvent(kind: string, fields: Record<string, unknown> = {}, now = Date.now()) {
  if (!enabled) return;
  const event = { ...sanitize(fields), t: now, kind } as DiagEvent;
  events.push(event);
  bytes += sizeOf(event);
  trim();
  loadDiagnostics().catch(() => {});
  scheduleSave();
}

export async function diagnosticsEvents(): Promise<DiagEvent[]> {
  await loadDiagnostics();
  return [...events];
}

export async function clearDiagnostics(): Promise<void> {
  await loadDiagnostics();
  events = [];
  bytes = 0;
  lastFix = null;
  await saveDiagnostics();
}

// The previous fix stays in memory only, to tell how far the next one is from it.
let lastFix: Fix | null = null;

export function logFix(source: FixSource, fix: Fix, outcome: FixOutcome, now = Date.now()) {
  if (!enabled) return;
  const moved = lastFix ? distanceM(lastFix, fix) : null;
  lastFix = fix;
  const moving = (fix.speed ?? 0) >= MOVING_SPEED_MS || (moved ?? 0) > MOVING_DISTANCE_M;
  logEvent(
    "fix",
    {
      src: source,
      out: outcome,
      acc: fix.accuracy == null ? null : Math.round(fix.accuracy),
      spd: fix.speed ?? null,
      dm: moved == null ? null : Math.round(moved),
      // How old the fix was when it was handled, long for fixes held offline.
      age: fix.recordedAt == null ? null : Math.max(0, Math.round((now - fix.recordedAt) / 1000)),
      moving,
    },
    now
  );
}

export function logError(source: string, error: unknown, now = Date.now()) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : safeString(error);
  const stack = error instanceof Error && error.stack ? error.stack.split("\n").slice(1, 4).join(" | ") : undefined;
  logEvent("error", { src: source, msg: message, stack }, now);
}

export function safeString(value: unknown): string {
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

// For tests: forget everything, also what is stored.
export function resetDiagnostics() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  events = [];
  bytes = 0;
  loaded = null;
  lastFix = null;
  lastBattery = null;
}

// The charge as it changes. Both reporting paths read it, only a change is logged.
let lastBattery: string | null = null;

export function logBattery(report: { level: number; charging: boolean } | null, now = Date.now()) {
  if (!enabled || !report) return;
  const key = `${report.level}:${report.charging}`;
  if (key === lastBattery) return;
  lastBattery = key;
  logEvent("battery", { level: report.level, charging: report.charging }, now);
}

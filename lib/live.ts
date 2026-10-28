import { LiveNative, type LiveContent, type LiveResult } from "../modules/neopin-live";
import { arrowAngle, bearingDeg, distanceBand, distanceBetween, formatMeters, type DistanceBand, type FindFix, type FindState } from "./find";
import { LOST_MS, nearbyText, type NearbyReading } from "./nearby";

// The search on the lock screen. Android shows an ongoing notification with the arrow and the
// metres, Android 16 keeps the metres in the status bar as a live update. iOS shows a Live
// Activity, on the lock screen and in the Dynamic Island.

export type { LiveContent };
export type ActiveFind = Extract<FindState, { phase: "active" }>;

// The arrow turns in steps, so the notification is not rebuilt for every compass flicker.
export const ARROW_STEP = 5;

function liveHint(band: DistanceBand, hasHeading: boolean): string {
  if (band === "far") return "Still a way to go";
  if (band === "close") return "Look around";
  return hasHeading ? "Follow the arrow" : "Turn until the distance drops";
}

// One line for the lock screen out of what the find screen knows.
export function liveContent(state: ActiveFind, mine: FindFix | null, heading: number | null, nearby: NearbyReading | null, now: number): LiveContent {
  const name = state.peer.displayName;
  const title = `Finding ${name}`;
  const theirs = state.theirs;
  const distance = mine && theirs ? distanceBetween(mine, theirs) : null;
  const metres = distance === null ? null : formatMeters(distance);
  // Bluetooth sees the other phone: on the last metres that beats any arrow.
  if (nearby && now - nearby.at <= LOST_MS) {
    return { title, text: metres ? `${metres} · Look around` : "Look around", short: nearbyText(nearby.band), arrowDeg: null };
  }
  if (!mine || !theirs || distance === null || metres === null) {
    return { title, text: theirs ? "Waiting for your own position…" : `Waiting for ${name}'s position…`, short: "…", arrowDeg: null };
  }
  const angle = heading === null ? null : arrowAngle(bearingDeg(mine, theirs), heading);
  const arrowDeg = angle === null ? null : (Math.round(angle / ARROW_STEP) * ARROW_STEP + 360) % 360;
  return { title, text: `${metres} · ${liveHint(distanceBand(distance), heading !== null)}`, short: metres, arrowDeg };
}

// Positions come every second and compass readings many times a second. The notification is
// rebuilt only when something visible changed, and an arrow-only change waits this long.
export const LIVE_MIN_MS = 500;

export class LiveUpdater {
  private lastText = "";
  private lastArrow: number | null = null;
  private lastAt = 0;

  constructor(private readonly send: (content: LiveContent) => void) {}

  update(content: LiveContent, now = Date.now()): boolean {
    const text = `${content.title}\n${content.text}\n${content.short}`;
    const textChanged = text !== this.lastText;
    if (!textChanged && content.arrowDeg === this.lastArrow) return false;
    if (!textChanged && now - this.lastAt < LIVE_MIN_MS) return false;
    this.lastText = text;
    this.lastArrow = content.arrowDeg;
    this.lastAt = now;
    this.send(content);
    return true;
  }

  reset() {
    this.lastText = "";
    this.lastArrow = null;
    this.lastAt = 0;
  }
}

export const liveAvailable = () => LiveNative !== null;

export function showLive(content: LiveContent): Promise<LiveResult | "unavailable"> {
  if (!LiveNative) return Promise.resolve("unavailable");
  return LiveNative.show(content).catch(() => "failed" as const);
}

export function hideLive() {
  LiveNative?.hide().catch(() => {});
}

// The Stop button on the notification. Returns the function that stops listening.
export function onLiveStop(listener: () => void): () => void {
  const sub = LiveNative?.addListener("onAction", ({ action }) => {
    if (action === "stop") listener();
  });
  return () => sub?.remove();
}

// Height above sea level: what the phone sends with a fix, and how the heights the server looks up
// (from terrain data, not the GPS) read on screen. Older servers send none, then nothing shows.
// Kept free of native modules so it can be tested.

import type { HighestPoint } from "@/lib/api";

// Below the Dead Sea or above Everest is a broken reading, not a place.
const LOWEST_M = -500;
const HIGHEST_M = 9000;
// GPS heights are rarely better than a few metres; worse than this says nothing.
const MAX_ALTITUDE_ACCURACY_M = 1000;

// The height of one fix for the server, whole metres. null (unknown) and nonsense stay out.
export function fixAltitude(
  altitude: number | null | undefined,
  altitudeAccuracy: number | null | undefined
): { altitude?: number; altitudeAccuracy?: number } {
  if (altitude == null || !Number.isFinite(altitude) || altitude < LOWEST_M || altitude > HIGHEST_M) return {};
  // iOS reports a negative accuracy when it does not know.
  const accurate =
    altitudeAccuracy != null && Number.isFinite(altitudeAccuracy) && altitudeAccuracy >= 0 && altitudeAccuracy <= MAX_ALTITUDE_ACCURACY_M;
  return { altitude: Math.round(altitude), ...(accurate && { altitudeAccuracy: Math.round(altitudeAccuracy) }) };
}

// A height from the server, or null when it sent none or something odd.
export function readAltitude(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= LOWEST_M && value <= HIGHEST_M ? Math.round(value) : null;
}

// A climb or a descent in metres, or null when the server sent none.
export function readClimb(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

// "412 m", "1,240 m".
export function formatAltitude(meters: number): string {
  const rounded = Math.round(meters);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${rounded < 0 ? "-" : ""}${digits} m`;
}

// Where a device is: the height of its last position.
export function deviceAltitude(device: { position?: { altitude?: unknown } | null }): number | null {
  return readAltitude(device.position?.altitude);
}

// "↑ 85 m ↓ 40 m" under a trip; a side that is missing or under a metre stays out, a flat trip shows nothing.
export function climbText(ascentM: unknown, descentM: unknown): string | null {
  const up = readClimb(ascentM);
  const down = readClimb(descentM);
  const parts = [up ? `↑ ${formatAltitude(up)}` : "", down ? `↓ ${formatAltitude(down)}` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

// "85 metres up, 40 metres down" for the screen reader.
export function climbLabel(ascentM: unknown, descentM: unknown): string | null {
  const up = readClimb(ascentM);
  const down = readClimb(descentM);
  const parts = [up ? `${up} metres up` : "", down ? `${down} metres down` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export type ProfilePoint = [distanceM: number, altitudeM: number];

// The server's [[distanceM, altitudeM], …] of a trip, with broken pairs left out, in order of the way.
export function readProfile(value: unknown): ProfilePoint[] {
  if (!Array.isArray(value)) return [];
  const points: ProfilePoint[] = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const altitude = readAltitude(p[1]);
    if (typeof p[0] !== "number" || !Number.isFinite(p[0]) || p[0] < 0 || altitude === null) continue;
    points.push([p[0], altitude]);
  }
  return points.sort((a, b) => a[0] - b[0]);
}

// The profile as `columns` heights along the way, each the height where that column's
// stretch of the way is (interpolated between the points around it). Empty with fewer than two
// points or no distance between them.
export function sampleProfile(points: ProfilePoint[], columns: number): number[] {
  if (points.length < 2 || columns < 1) return [];
  const start = points[0][0];
  const span = points[points.length - 1][0] - start;
  if (!(span > 0)) return [];
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < columns; i++) {
    const at = start + (columns === 1 ? span / 2 : (span * i) / (columns - 1));
    while (j < points.length - 2 && points[j + 1][0] < at) j++;
    const [d0, a0] = points[j];
    const [d1, a1] = points[j + 1];
    const t = d1 > d0 ? Math.min(1, Math.max(0, (at - d0) / (d1 - d0))) : 0;
    out.push(a0 + (a1 - a0) * t);
  }
  return out;
}

export type ProfileBars = { ratios: number[]; lowM: number; highM: number };

// A few metres up and down should look flat, not like a mountain range: the scale spans at
// least this much.
const MIN_SPAN_M = 30;
// The lowest column still shows a sliver, so the profile reads as ground.
const FLOOR = 0.12;

// What the small profile under a trip draws: one height (0–1) per column, plus the lowest and
// highest point. null when there is nothing to draw.
export function profileBars(points: ProfilePoint[], columns: number): ProfileBars | null {
  const heights = sampleProfile(points, columns);
  if (heights.length === 0) return null;
  const lowM = Math.min(...points.map((p) => p[1]));
  const highM = Math.max(...points.map((p) => p[1]));
  const span = Math.max(MIN_SPAN_M, highM - lowM);
  // A flat profile sits in the middle of its range rather than on the floor.
  const base = lowM - (span - (highM - lowM)) / 2;
  const ratios = heights.map((h) => FLOOR + (1 - FLOOR) * Math.min(1, Math.max(0, (h - base) / span)));
  return { ratios, lowM, highM };
}

// The highest point of a review: its height and, when known, the place.
export function readHighest(value: unknown): HighestPoint | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const altitudeM = readAltitude(v.altitudeM);
  if (altitudeM === null) return null;
  return { altitudeM, name: typeof v.name === "string" && v.name.trim() ? v.name.trim() : null };
}

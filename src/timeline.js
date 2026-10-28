import { distanceM } from "./history.js";

// Turns a day of position fixes into what Google Timeline shows: the places you
// stayed at ("visits") and the ways between them ("trips").
export const STOP_RADIUS_M = 75;
export const MIN_VISIT_MS = 5 * 60_000;
const MERGE_VISITS_M = 150;
export const MIN_TRIP_M = 150;
// Faster than this between two fixes is a GPS jump. High-speed trains run up to 300 km/h.
const MAX_SPEED_MS = 95;
// Longer than this without a fix is a gap: the phone was off or out of reach, nobody knows the way.
export const GAP_MS = 15 * 60_000;

function centroid(points) {
  const n = points.length;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / n,
    lon: points.reduce((s, p) => s + p.lon, 0) / n,
  };
}

function dropJumps(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev) {
      const dt = (p.ts - prev.ts) / 1000;
      if (dt > 0 && distanceM(prev.lat, prev.lon, p.lat, p.lon) / dt > MAX_SPEED_MS) continue;
    }
    out.push(p);
  }
  return out;
}

function modeFor(distance, durationMs) {
  const kmh = durationMs > 0 ? distance / 1000 / (durationMs / 3_600_000) : 0;
  if (kmh < 7) return "walking";
  if (kmh < 22) return "cycling";
  return "driving";
}

function pathLength(points) {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += distanceM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return distance;
}

function visitSegment(points) {
  const c = centroid(points);
  const start = points[0].ts;
  const end = points[points.length - 1].ts;
  return { type: "visit", start, end, durationMs: end - start, lat: c.lat, lon: c.lon, pointCount: points.length };
}

export function tripSegment(points) {
  const distance = pathLength(points);
  const start = points[0].ts;
  const end = points[points.length - 1].ts;
  const trip = {
    type: "trip",
    start,
    end,
    durationMs: end - start,
    distanceM: Math.round(distance),
    mode: modeFor(distance, end - start),
    path: points.map((p) => [p.lat, p.lon]),
  };
  // The fixes with their times, for telling a bus ride from a drive. Not part of the JSON.
  Object.defineProperty(trip, "fixes", { value: points, enumerable: false });
  return trip;
}

// Where the phone went without a fix for a long time, only start and end are known. The
// clients draw it dashed, it counts neither as distance nor as moving.
function gapSegment(a, b) {
  const distance = distanceM(a.lat, a.lon, b.lat, b.lon);
  if (distance < MIN_TRIP_M) return null;
  return { ...tripSegment([a, b]), gap: true };
}

// The fixes of one way between two stops, split where the phone went silent.
function tripsAlong(path) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const trip = tripSegment(run);
      if (trip.distanceM >= MIN_TRIP_M) out.push(trip);
    }
  };
  for (const p of path) {
    const last = run.at(-1);
    if (last && p.ts - last.ts > GAP_MS) {
      flush();
      const gap = gapSegment(last, p);
      if (gap) out.push(gap);
      run = [];
    }
    run.push(p);
  }
  flush();
  return out;
}

// Whether a stretch of time overlaps a stop the person dismissed.
const touchesDismissed = (from, to, dismissed) => dismissed.some((d) => from <= d.end && to >= d.start);

// `dismissed` are the time spans of stops the person said were none, a red light or a jam:
// fixes there are on the way, so the trips on both sides become one.
export function buildTimeline(rawPoints, { dismissed = [] } = {}) {
  const points = dropJumps([...rawPoints].sort((a, b) => a.ts - b.ts));
  const parts = [];
  let moving = [];
  const flushMoving = () => {
    if (moving.length) parts.push({ kind: "move", points: moving });
    moving = [];
  };

  let i = 0;
  while (i < points.length) {
    const group = [points[i]];
    let c = centroid(group);
    let j = i;
    while (j + 1 < points.length && distanceM(c.lat, c.lon, points[j + 1].lat, points[j + 1].lon) <= STOP_RADIUS_M) {
      j++;
      group.push(points[j]);
      c = centroid(group);
    }
    if (points[j].ts - points[i].ts >= MIN_VISIT_MS && !touchesDismissed(points[i].ts, points[j].ts, dismissed)) {
      flushMoving();
      parts.push({ kind: "visit", points: group });
      i = j + 1;
    } else {
      moving.push(points[i]);
      i++;
    }
  }
  flushMoving();

  // One place with a short wobble in between is a single visit.
  const merged = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    const before = merged[merged.length - 2];
    if (part.kind === "visit" && prev?.kind === "move" && before?.kind === "visit") {
      const a = centroid(before.points);
      const b = centroid(part.points);
      if (distanceM(a.lat, a.lon, b.lat, b.lon) <= MERGE_VISITS_M && pathLength(prev.points) < MIN_TRIP_M * 2) {
        before.points = [...before.points, ...prev.points, ...part.points];
        merged.pop();
        continue;
      }
    }
    merged.push(part);
  }

  const segments = [];
  merged.forEach((part, k) => {
    if (part.kind === "visit") {
      segments.push(visitSegment(part.points));
      return;
    }
    // Anchored to the middle of the neighbouring visits, where their markers sit, so the
    // route starts and ends right at the stops.
    const prev = merged[k - 1]?.kind === "visit" ? merged[k - 1].points : null;
    const next = merged[k + 1]?.kind === "visit" ? merged[k + 1].points : null;
    const from = prev ? [{ ...centroid(prev), ts: prev.at(-1).ts }] : [];
    const to = next ? [{ ...centroid(next), ts: next[0].ts }] : [];
    segments.push(...tripsAlong([...from, ...part.points, ...to]));
  });
  // Two visits right after each other with a gap between them (no fixes in between).
  for (let k = 1; k < segments.length; k++) {
    const a = segments[k - 1];
    const b = segments[k];
    if (a.type === "visit" && b.type === "visit" && b.start - a.end > GAP_MS) {
      const gap = gapSegment({ lat: a.lat, lon: a.lon, ts: a.end }, { lat: b.lat, lon: b.lon, ts: b.start });
      if (gap) segments.splice(k++, 0, gap);
    }
  }

  const trips = segments.filter((s) => s.type === "trip" && !s.gap);
  return {
    segments,
    summary: {
      visits: segments.filter((s) => s.type === "visit").length,
      distanceM: trips.reduce((s, t) => s + t.distanceM, 0),
      movingMs: trips.reduce((s, t) => s + t.durationMs, 0),
      pointCount: points.length,
    },
  };
}

// Start and end of a local calendar day in epoch milliseconds. `tzOffsetMin` is
// what JavaScript's getTimezoneOffset() returns, UTC minus local time.
export function dayRange(date, tzOffsetMin = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!match) return null;
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + tzOffsetMin * 60_000;
  if (Number.isNaN(start)) return null;
  return { from: start, to: start + 86_400_000 };
}

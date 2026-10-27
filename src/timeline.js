import { distanceM } from "./history.js";

// Turns a day of position fixes into what Google Timeline shows: the places you
// stayed at ("visits") and the ways between them ("trips").
export const STOP_RADIUS_M = 75;
export const MIN_VISIT_MS = 5 * 60_000;
const MERGE_VISITS_M = 150;
const MIN_TRIP_M = 150;
const MAX_SPEED_MS = 70; // faster than this between two fixes is a GPS jump

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

function tripSegment(points) {
  const distance = pathLength(points);
  const start = points[0].ts;
  const end = points[points.length - 1].ts;
  return {
    type: "trip",
    start,
    end,
    durationMs: end - start,
    distanceM: Math.round(distance),
    mode: modeFor(distance, end - start),
    path: points.map((p) => [p.lat, p.lon]),
  };
}

export function buildTimeline(rawPoints) {
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
    if (points[j].ts - points[i].ts >= MIN_VISIT_MS) {
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
    // Anchored to the neighbouring visits, so the route has no gap on the map.
    const from = merged[k - 1]?.kind === "visit" ? [merged[k - 1].points.at(-1)] : [];
    const to = merged[k + 1]?.kind === "visit" ? [merged[k + 1].points[0]] : [];
    const path = [...from, ...part.points, ...to];
    if (path.length < 2) return;
    const trip = tripSegment(path);
    if (trip.distanceM >= MIN_TRIP_M) segments.push(trip);
  });

  const trips = segments.filter((s) => s.type === "trip");
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

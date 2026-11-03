import { buildGraph, projection } from "./graph.js";
import { ensureTiles, haveTiles, tilesAlong, waysOfTiles } from "./fetch.js";
import { chainGeometry, lengthXY, smoothed, thin, viterbi, withoutSpikes } from "./match.js";

// NeoPin's own map matcher: road tiles from OpenStreetMap (fetch.js, vectorTiles.js), a graph
// per match (graph.js), a hidden Markov model over it (match.js). Nobody else sees the trips.

// One graph covers at most this many tiles (about 6 by 6 km); longer trips are matched in
// sections, which bounds the memory a match takes.
const MAX_TILES_PER_GRAPH = 36;
// A road this much longer than the fixes is a detour the phone never made: that chain keeps
// its fixes.
const MAX_STRETCH = 1.5;
const MAX_EXTRA_M = 200;
// At least this share of the fixes has to be on the roads, or the trip keeps its fixes.
const MIN_MATCHED_SHARE = 0.5;

const round = (v) => Math.round(v * 1e6) / 1e6;

// Fixes closer together than TUNING.thinM, and repeats, are dropped first.
export function thinFixes(fixes) {
  if (!fixes.length) return [];
  const first = projection(fixes[0].lat, fixes[0].lon);
  const points = fixes.map((f) => {
    const [x, y] = first.toXY(f.lat, f.lon);
    return { lat: f.lat, lon: f.lon, accuracy: f.accuracy, ts: f.ts, x, y };
  });
  return thin(points).map(({ x, y, ...p }) => p);
}

// Consecutive sections of points whose tiles fit one graph; each starts where the one before ended.
function sections(points) {
  const out = [];
  let start = 0;
  const key = ([x, y]) => `${x}/${y}`;
  while (start < points.length - 1) {
    let end = start + 1;
    const tiles = new Map(tilesAlong(points.slice(start, end + 1)).map((t) => [key(t), t]));
    // A gap of many kilometres between two fixes: nobody knows the way, a straight line.
    if (tiles.size > MAX_TILES_PER_GRAPH) {
      out.push({ points: points.slice(start, end + 1), tiles: null });
      start = end;
      continue;
    }
    while (end + 1 < points.length) {
      const more = tilesAlong(points.slice(end, end + 2)).filter((t) => !tiles.has(key(t)));
      if (tiles.size + more.length > MAX_TILES_PER_GRAPH) break;
      for (const t of more) tiles.set(key(t), t);
      end++;
    }
    out.push({ points: points.slice(start, end + 1), tiles: [...tiles.values()] });
    start = end;
  }
  return out;
}

// One section: its roads where chains of fixes fit them, the fixes themselves elsewhere.
export function matchOnWays(ways, profile, points) {
  const mid = points[points.length >> 1];
  const g = buildGraph(ways, profile, mid);
  const xy = smoothed(
    withoutSpikes(
      points.map((p) => {
        const [x, y] = g.proj.toXY(p.lat, p.lon);
        return { ...p, x, y };
      }),
      profile
    ),
    profile
  );
  const chains = viterbi(g, xy).filter((c) => c.length >= 2);
  const chainAt = new Map(chains.map((c) => [c[0].index, c]));
  const path = [];
  let matched = 0;
  for (let i = 0; i < xy.length; i++) {
    const chain = chainAt.get(i);
    if (!chain) {
      path.push([round(xy[i].lat), round(xy[i].lon)]);
      continue;
    }
    const road = chainGeometry(g, xy, chain);
    const fixes = chain.map((c) => [xy[c.index].x, xy[c.index].y]);
    if (lengthXY(road) <= lengthXY(fixes) * MAX_STRETCH + MAX_EXTRA_M) {
      for (const [x, y] of road) path.push(g.proj.toLatLon(x, y).map(round));
      matched += chain.length;
    } else {
      for (const c of chain) path.push([round(xy[c.index].lat), round(xy[c.index].lon)]);
    }
    i = chain[chain.length - 1].index;
  }
  return { path, matched };
}

const layerOf = (profile) => (profile === "rail" ? "rail" : "roads");

// Every tile the sections of these points need.
function tilesOf(parts) {
  const all = new Map();
  for (const s of parts) for (const t of s.tiles ?? []) all.set(`${t[0]}/${t[1]}`, t);
  return [...all.values()];
}

// Whether the road tiles for these fixes are all stored, so matching them asks nobody.
export function tilesReady(fixes, profile) {
  const points = thinFixes(fixes);
  return points.length < 2 || haveTiles(layerOf(profile), tilesOf(sections(points)));
}

// Asks for the road tiles of these fixes in the background, unless they failed a moment ago.
export function loadTiles(fixes, profile) {
  const points = thinFixes(fixes);
  if (points.length >= 2) ensureTiles(layerOf(profile), tilesOf(sections(points))).catch(() => {});
}

// Thrown when the tiles of a trip did not come within tilesWaitMs; they are still on their way.
export class TilesPending extends Error {
  constructor() {
    super("Road tiles are still loading");
    this.name = "TilesPending";
  }
}

// The fixes ({ lat, lon, accuracy?, ts? }) on the roads of a profile (car, bike, foot):
// { path: [[lat, lon]], snapped } or null when too few fit the roads. Waits for road tiles that
// are not stored yet (at most tilesWaitMs, then TilesPending while they go on loading), and
// throws when one of them cannot be had right now.
export async function matchOnRoads(fixes, profile, { tilesWaitMs = Infinity } = {}) {
  const points = thinFixes(fixes);
  if (points.length < 2) return null;
  const layer = layerOf(profile);
  const path = [];
  let matched = 0;
  let counted = 0;
  const parts = sections(points);
  // All tiles first: a trip that is new to the server costs a few requests, not one per section.
  const loading = ensureTiles(layer, tilesOf(parts));
  if (Number.isFinite(tilesWaitMs)) {
    loading.catch(() => {});
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve(true), tilesWaitMs)));
    const timedOut = await Promise.race([loading.then(() => false), late]).finally(() => clearTimeout(timer));
    if (timedOut) throw new TilesPending();
  } else await loading;
  for (const [k, section] of parts.entries()) {
    const part = section.tiles
      ? matchOnWays(await waysOfTiles(layer, section.tiles), profile, section.points)
      : { path: section.points.map((p) => [round(p.lat), round(p.lon)]), matched: 0 };
    // The first point of a section is the last of the one before.
    counted += section.points.length - (k ? 1 : 0);
    matched += Math.min(part.matched, section.points.length - (k ? 1 : 0));
    for (const p of part.path) {
      const last = path[path.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p);
    }
  }
  if (matched / counted < MIN_MATCHED_SHARE || path.length < 2) return null;
  return { path, snapped: true, matchedShare: matched / counted };
}

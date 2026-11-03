// A routable graph from OpenStreetMap ways, built per match from the cached tiles. Every node
// of a usable way is a vertex, every stretch between two of them an edge: ways that share a
// node are connected there, which is how OSM models junctions (from vector tiles a node is a
// position on the tile grid, see vectorTiles.js). Coordinates are metres east and north of an
// origin, good enough for the few kilometres one graph covers.

const YES = new Set(["yes", "true", "1", "designated", "permissive", "official"]);
const NO = new Set(["no", "use_sidepath"]);

const CAR_ROADS = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
  "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service", "road",
]);
const MOTOR_ROADS = new Set(["motorway", "motorway_link", "trunk", "trunk_link"]);
const NOT_A_WAY = new Set(["proposed", "construction", "abandoned", "platform", "raceway", "bus_stop", "elevator", "corridor", "rest_area", "services"]);

// The highway values worth downloading at all; the profiles pick from them.
export const HIGHWAYS = [
  ...CAR_ROADS, "track", "pedestrian", "footway", "path", "cycleway", "steps", "bridleway", "busway",
];

const isNo = (value) => value !== undefined && NO.has(value);
const isYes = (value) => value !== undefined && YES.has(value);

// Which way a way may be travelled: +1 along its nodes, -1 against them, 0 both.
function onewayOf(tags, profile) {
  if (profile === "foot" || profile === "rail") return 0;
  if (profile === "bike") {
    if (tags["oneway:bicycle"] === "no" || /^opposite/.test(tags.cycleway ?? "")) return 0;
    if (tags["oneway:bicycle"] === "yes") return 1;
  }
  const o = tags.oneway;
  if (o === "-1" || o === "reverse") return -1;
  if (o === "yes" || o === "true" || o === "1") return 1;
  if (o === "no") return 0;
  // A roundabout and a motorway go one way even without saying so.
  if (tags.junction === "roundabout" || tags.junction === "circular" || tags.highway === "motorway") return profile === "car" || profile === "bike" ? 1 : 0;
  return 0;
}

// The rules of each profile: may it use the way at all? Unknown access counts as allowed.
const ALLOWED = {
  car(tags) {
    const hw = tags.highway;
    if (!CAR_ROADS.has(hw) && hw !== "track") return false;
    if (isNo(tags.motorcar) || isNo(tags.motor_vehicle) || isNo(tags.vehicle)) return false;
    if (isNo(tags.access) && !isYes(tags.motorcar ?? tags.motor_vehicle)) return false;
    return true;
  },
  bike(tags) {
    const hw = tags.highway;
    if (!HIGHWAYS.includes(hw)) return false;
    if (isYes(tags.bicycle)) return true;
    if (isNo(tags.bicycle) || isNo(tags.vehicle) || isNo(tags.access)) return false;
    // Motorways and motorroads (Kraftfahrstraßen) are closed to bikes.
    if (hw === "motorway" || hw === "motorway_link" || tags.motorroad === "yes") return false;
    return hw !== "steps";
  },
  foot(tags) {
    const hw = tags.highway;
    if (!HIGHWAYS.includes(hw)) return false;
    if (isYes(tags.foot)) return true;
    if (isNo(tags.foot) || isNo(tags.access)) return false;
    if (MOTOR_ROADS.has(hw) || tags.motorroad === "yes") return false;
    return true;
  },
  // Prepared for trains, trams and light rail between their stations: the tile layer "rail"
  // (see fetch.js) brings these ways, nothing asks for them yet.
  rail(tags) {
    return ["rail", "light_rail", "tram", "subway", "narrow_gauge"].includes(tags.railway) && !["abandoned", "disused", "construction"].includes(tags.railway);
  },
};

// A field or forest track is a car's way only where nothing else is: it costs this many times
// its length, and a fix near a road is not put on a track beside it.
const TRACK_COST = 4;

// How a profile may use a way: null for not at all, else the direction (+1, -1 or 0 for both),
// and for a way of last resort its cost per metre and `low`.
export function wayRule(profile, tags = {}) {
  if (profile !== "rail" && (NOT_A_WAY.has(tags.highway) || tags.area === "yes")) return null;
  const allowed = ALLOWED[profile];
  if (!allowed || !allowed(tags)) return null;
  const rule = { oneway: onewayOf(tags, profile) };
  if (profile === "car" && tags.highway === "track" && !isYes(tags.motor_vehicle ?? tags.motorcar)) Object.assign(rule, { cost: TRACK_COST, low: true });
  return rule;
}

// Metres east and north of an origin, and back.
export function projection(lat0, lon0) {
  const ky = 111_320;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

// Edge flags: travel from a to b, from b to a.
export const FORWARD = 1;
export const BACKWARD = 2;

const CELL_M = 64;
// A way that ends this close to another way without a shared node is joined to it there: the
// lines of vector tiles meet by position, and a junction the tile simplified away, or the cut at
// a tile's edge, can leave an end a few decimetres off.
export const JOIN_M = 1;

// The segments in the cells a box touches, each once, by calling visit(s).
function forSegmentsIn(cells, x0, y0, x1, y1, visit) {
  const seen = new Set();
  for (let cx = Math.floor(x0 / CELL_M); cx <= Math.floor(x1 / CELL_M); cx++) {
    for (let cy = Math.floor(y0 / CELL_M); cy <= Math.floor(y1 / CELL_M); cy++) {
      for (const s of cells.get(cx * 1_000_003 + cy) ?? []) {
        if (!seen.has(s)) {
          seen.add(s);
          visit(s);
        }
      }
    }
  }
}

function cellsOf(xs, ys, segA, segB) {
  const cells = new Map();
  for (let s = 0; s < segA.length; s++) {
    const ax = xs[segA[s]], ay = ys[segA[s]], bx = xs[segB[s]], by = ys[segB[s]];
    const x0 = Math.floor(Math.min(ax, bx) / CELL_M), x1 = Math.floor(Math.max(ax, bx) / CELL_M);
    const y0 = Math.floor(Math.min(ay, by) / CELL_M), y1 = Math.floor(Math.max(ay, by) / CELL_M);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cx * 1_000_003 + cy;
        const list = cells.get(key);
        if (list) list.push(s);
        else cells.set(key, [s]);
      }
    }
  }
  return cells;
}

// Joins every loose end (a vertex with one segment) within JOIN_M of another way: to a vertex
// there, or into the segment it is next to, which is split at that spot. Changes the lists.
function joinLooseEnds(xs, ys, seg) {
  const n = xs.length;
  const degree = new Int32Array(n);
  for (let s = 0; s < seg.a.length; s++) {
    degree[seg.a[s]]++;
    degree[seg.b[s]]++;
  }
  const cells = cellsOf(xs, ys, seg.a, seg.b);
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const root = (v) => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  const splits = new Map();
  for (let v = 0; v < n; v++) {
    if (degree[v] !== 1) continue;
    const x = xs[v], y = ys[v];
    let best = null;
    forSegmentsIn(cells, x - JOIN_M, y - JOIN_M, x + JOIN_M, y + JOIN_M, (s) => {
      const a = seg.a[s], b = seg.b[s];
      if (a === v || b === v) return;
      const dx = xs[b] - xs[a], dy = ys[b] - ys[a];
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - xs[a]) * dx + (y - ys[a]) * dy) / len2));
      const d = Math.hypot(x - (xs[a] + dx * t), y - (ys[a] + dy * t));
      if (d <= JOIN_M && (!best || d < best.d)) best = { s, t, d, len: Math.sqrt(len2) };
    });
    if (!best) continue;
    const { s, t, len } = best;
    // Near an end of that segment: the same spot as its vertex.
    if (t * len <= JOIN_M || (1 - t) * len <= JOIN_M) {
      const w = t * len <= JOIN_M ? seg.a[s] : seg.b[s];
      if (root(w) !== root(v)) parent[root(v)] = root(w);
    } else {
      if (!splits.has(s)) splits.set(s, []);
      splits.get(s).push([t, v]);
    }
  }
  // Split segments become a chain through the ends joined to them, same direction.
  for (const [s, list] of splits) {
    list.sort((p, q) => p[0] - q[0]);
    const chain = [seg.a[s], ...list.map(([, v]) => v), seg.b[s]];
    seg.b[s] = chain[1];
    for (let k = 1; k < chain.length - 1; k++) {
      seg.a.push(chain[k]);
      seg.b.push(chain[k + 1]);
      seg.dir.push(seg.dir[s]);
      seg.cost.push(seg.cost[s]);
      seg.low.push(seg.low[s]);
    }
  }
  for (let s = 0; s < seg.a.length; s++) {
    seg.a[s] = root(seg.a[s]);
    seg.b[s] = root(seg.b[s]);
  }
}

// ways: [{ id, tags, nodes: [osm ids, or positions], lat: [], lon: [] }] (duplicates across
// tiles are fine).
export function buildGraph(ways, profile, origin) {
  const proj = projection(origin.lat, origin.lon);
  const vertexOf = new Map();
  const xs = [];
  const ys = [];
  const seg = { a: [], b: [], dir: [], cost: [], low: [] };
  const seen = new Set();
  const vertex = (id, lat, lon) => {
    let v = vertexOf.get(id);
    if (v === undefined) {
      v = xs.length;
      vertexOf.set(id, v);
      const [x, y] = proj.toXY(lat, lon);
      xs.push(x);
      ys.push(y);
    }
    return v;
  };
  for (const way of ways) {
    if (seen.has(way.id)) continue;
    seen.add(way.id);
    const rule = wayRule(profile, way.tags);
    if (!rule) continue;
    const dir = rule.oneway === 1 ? FORWARD : rule.oneway === -1 ? BACKWARD : FORWARD | BACKWARD;
    let prev = vertex(way.nodes[0], way.lat[0], way.lon[0]);
    for (let i = 1; i < way.nodes.length; i++) {
      const v = vertex(way.nodes[i], way.lat[i], way.lon[i]);
      if (v !== prev) {
        seg.a.push(prev);
        seg.b.push(v);
        seg.dir.push(dir);
        seg.cost.push(rule.cost ?? 1);
        seg.low.push(rule.low ? 1 : 0);
      }
      prev = v;
    }
  }
  joinLooseEnds(xs, ys, seg);
  // Joined ends can leave a segment from a vertex to itself.
  const keep = [];
  for (let s = 0; s < seg.a.length; s++) if (seg.a[s] !== seg.b[s]) keep.push(s);
  const n = xs.length;
  const m = keep.length;
  const g = {
    profile,
    proj,
    vertexCount: n,
    segmentCount: m,
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    segA: Int32Array.from(keep, (s) => seg.a[s]),
    segB: Int32Array.from(keep, (s) => seg.b[s]),
    segDir: Uint8Array.from(keep, (s) => seg.dir[s]),
    segLow: Uint8Array.from(keep, (s) => seg.low[s]),
    segLen: new Float64Array(m),
    // What a metre of the segment costs a route: its length, more for a way of last resort.
    segCost: new Float64Array(m),
  };
  for (let s = 0; s < m; s++) {
    g.segLen[s] = Math.hypot(g.x[g.segB[s]] - g.x[g.segA[s]], g.y[g.segB[s]] - g.y[g.segA[s]]);
    g.segCost[s] = g.segLen[s] * seg.cost[keep[s]];
  }

  // Outgoing edges per vertex (CSR): the segment and the vertex it leads to.
  const degree = new Int32Array(n + 1);
  for (let s = 0; s < m; s++) {
    if (g.segDir[s] & FORWARD) degree[g.segA[s] + 1]++;
    if (g.segDir[s] & BACKWARD) degree[g.segB[s] + 1]++;
  }
  for (let v = 0; v < n; v++) degree[v + 1] += degree[v];
  g.adjStart = degree;
  g.adjSeg = new Int32Array(degree[n]);
  g.adjTo = new Int32Array(degree[n]);
  const fill = degree.slice(0, n);
  for (let s = 0; s < m; s++) {
    if (g.segDir[s] & FORWARD) {
      const k = fill[g.segA[s]]++;
      g.adjSeg[k] = s;
      g.adjTo[k] = g.segB[s];
    }
    if (g.segDir[s] & BACKWARD) {
      const k = fill[g.segB[s]]++;
      g.adjSeg[k] = s;
      g.adjTo[k] = g.segA[s];
    }
  }

  // A grid of cells for finding the segments near a fix.
  g.cells = cellsOf(g.x, g.y, g.segA, g.segB);
  g.mark = new Int32Array(m);
  g.markGen = 0;
  return g;
}

// The segments within r metres of (x, y): for each the share along it (t, 0 at a) and the distance.
export function segmentsNear(g, x, y, r) {
  const out = [];
  const gen = ++g.markGen;
  const x0 = Math.floor((x - r) / CELL_M), x1 = Math.floor((x + r) / CELL_M);
  const y0 = Math.floor((y - r) / CELL_M), y1 = Math.floor((y + r) / CELL_M);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const list = g.cells.get(cx * 1_000_003 + cy);
      if (!list) continue;
      for (const s of list) {
        if (g.mark[s] === gen) continue;
        g.mark[s] = gen;
        const ax = g.x[g.segA[s]], ay = g.y[g.segA[s]];
        const dx = g.x[g.segB[s]] - ax, dy = g.y[g.segB[s]] - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const px = ax + dx * t, py = ay + dy * t;
        const d = Math.hypot(x - px, y - py);
        if (d <= r) out.push({ seg: s, t, d, x: px, y: py });
      }
    }
  }
  return out;
}

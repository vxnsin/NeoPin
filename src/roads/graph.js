// A routable graph from OpenStreetMap ways, built per match from the cached tiles. Every OSM
// node of a usable way is a vertex, every stretch between two of them an edge: ways that share
// a node are connected there, which is how OSM models junctions. Coordinates are metres east
// and north of an origin, good enough for the few kilometres one graph covers.

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
    if (!CAR_ROADS.has(hw) && !(hw === "track" && isYes(tags.motor_vehicle ?? tags.motorcar))) return false;
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

// How a profile may use a way: null for not at all, else the direction (+1, -1 or 0 for both).
export function wayRule(profile, tags = {}) {
  if (profile !== "rail" && (NOT_A_WAY.has(tags.highway) || tags.area === "yes")) return null;
  const allowed = ALLOWED[profile];
  if (!allowed || !allowed(tags)) return null;
  return { oneway: onewayOf(tags, profile) };
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

// ways: [{ id, tags, nodes: [osm ids], lat: [], lon: [] }] (duplicates across tiles are fine).
export function buildGraph(ways, profile, origin) {
  const proj = projection(origin.lat, origin.lon);
  const vertexOf = new Map();
  const xs = [];
  const ys = [];
  const segA = [];
  const segB = [];
  const segDir = [];
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
        segA.push(prev);
        segB.push(v);
        segDir.push(dir);
      }
      prev = v;
    }
  }
  const n = xs.length;
  const m = segA.length;
  const g = {
    profile,
    proj,
    vertexCount: n,
    segmentCount: m,
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    segA: Int32Array.from(segA),
    segB: Int32Array.from(segB),
    segDir: Uint8Array.from(segDir),
    segLen: new Float64Array(m),
  };
  for (let s = 0; s < m; s++) g.segLen[s] = Math.hypot(g.x[g.segB[s]] - g.x[g.segA[s]], g.y[g.segB[s]] - g.y[g.segA[s]]);

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
  const cells = new Map();
  for (let s = 0; s < m; s++) {
    const ax = g.x[g.segA[s]], ay = g.y[g.segA[s]], bx = g.x[g.segB[s]], by = g.y[g.segB[s]];
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
  g.cells = cells;
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

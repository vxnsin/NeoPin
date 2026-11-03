import zlib from "node:zlib";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

// Roads from OpenMapTiles vector tiles (OpenFreeMap serves them, the same tiles the map of the
// dashboard is drawn from): the `transportation` layer of a zoom 14 tile, see
// https://openmaptiles.org/schema/#transportation. Its lines carry a class and a few OSM tags
// instead of node ids, so a vertex is known by where it is: two lines that meet at a junction
// share a position on the grid of the tile (4096 by 4096, about 0.4 m in Germany). The lines are
// cut at the edge of their tile, so neighbouring tiles meet exactly there.

// Positions on one grid for the whole world: tile x * GRID + position in the tile.
const GRID = 4096;
const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
const PATHS = new Set(["footway", "path", "cycleway", "steps", "pedestrian", "bridleway"]);
const RAILS = new Set(["rail", "light_rail", "tram", "subway", "narrow_gauge"]);

// The OSM tags graph.js understands, from the attributes of one transportation feature; null for
// what nobody travels on (platforms, corridors, ferries, piers, areas).
export function tagsFromOpenMapTiles(p = {}) {
  const tags = {};
  const cls = p.class;
  if (MAJOR.has(cls)) tags.highway = p.ramp === 1 ? `${cls}_link` : cls;
  // unclassified, residential, living_street and road are all "minor".
  else if (cls === "minor") tags.highway = "residential";
  else if (cls === "service" || cls === "track" || cls === "busway") tags.highway = cls;
  else if (cls === "path") {
    if (!p.subclass) tags.highway = "path";
    else if (PATHS.has(p.subclass)) tags.highway = p.subclass;
    else return null;
  } else if ((cls === "rail" || cls === "transit") && RAILS.has(p.subclass)) tags.railway = p.subclass;
  else return null;
  if (p.oneway === 1) tags.oneway = "yes";
  else if (p.oneway === -1) tags.oneway = "-1";
  // OpenMapTiles only says access=no; foot and bicycle as tagged.
  for (const key of ["access", "foot", "bicycle", "service"]) if (typeof p[key] === "string") tags[key] = p[key];
  // A motorway-like road (Kraftfahrstraße): closed to bikes and walkers like a motorroad.
  if (p.expressway === 1) tags.motorroad = "yes";
  return tags;
}

// Gzipped tiles are unpacked; fetch already does that when the server says so.
const unpacked = (buffer) => (buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer) : buffer);

// The pieces of a line inside the box [0, e] x [0, e], each a list of [x, y] (Liang-Barsky per stretch).
export function clipLine(points, e) {
  const out = [];
  let run = null;
  const end = () => {
    if (run?.length >= 2) out.push(run);
    run = null;
  };
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    let inside = true;
    for (const [p, q] of [[-dx, ax], [dx, e - ax], [-dy, ay], [dy, e - ay]]) {
      if (p === 0) {
        if (q < 0) inside = false;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    if (!inside || t0 > t1) {
      end();
      continue;
    }
    const from = t0 > 0 ? [ax + dx * t0, ay + dy * t0] : [ax, ay];
    const to = t1 < 1 ? [ax + dx * t1, ay + dy * t1] : [bx, by];
    if (!run || t0 > 0) {
      end();
      run = [from];
    }
    run.push(to);
    if (t1 < 1) end();
  }
  end();
  return out;
}

// One tile's ways per layer, { roads: [...], rail: [...] }, in the form fetch.js stores and
// graph.js builds from: { id, tags, nodes, lat, lon }. The nodes are positions on the world grid.
export function waysFromVectorTile(buffer, x, y, z = 14) {
  const out = { roads: [], rail: [] };
  const layer = new VectorTile(new PbfReader(unpacked(buffer))).layers.transportation;
  if (!layer) return out;
  const e = layer.extent;
  const size = 2 ** z * GRID;
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2) continue;
    const tags = tagsFromOpenMapTiles(feature.properties);
    if (!tags) continue;
    const target = tags.railway ? out.rail : out.roads;
    let k = 0;
    for (const line of feature.loadGeometry()) {
      for (const piece of clipLine(line.map((p) => [p.x, p.y]), e)) {
        const nodes = [];
        const lat = [];
        const lon = [];
        for (const [px, py] of piece) {
          const gx = Math.round(x * GRID + (px / e) * GRID);
          const gy = Math.round(y * GRID + (py / e) * GRID);
          const node = gx * size + gy;
          if (node === nodes[nodes.length - 1]) continue;
          nodes.push(node);
          lon.push((gx / size) * 360 - 180);
          lat.push((Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / size))) * 180) / Math.PI);
        }
        if (nodes.length >= 2) target.push({ id: `${x}/${y}/${i}/${k++}`, tags, nodes, lat, lon });
      }
    }
  }
  return out;
}

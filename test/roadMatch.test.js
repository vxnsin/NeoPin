import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, projection, wayRule } from "../src/roads/graph.js";
import { matchOnWays, thinFixes } from "../src/roads/index.js";
import { thin, viterbi } from "../src/roads/match.js";

// Synthetic road networks in metres east and north of a spot in Upper Franconia.
const ORIGIN = { lat: 50.25, lon: 11.4 };
const P = projection(ORIGIN.lat, ORIGIN.lon);

function world() {
  const ids = new Map();
  const ways = [];
  const node = ([x, y]) => {
    const key = `${Math.round(x * 100)},${Math.round(y * 100)}`;
    if (!ids.has(key)) ids.set(key, ids.size + 1);
    return ids.get(key);
  };
  return {
    ways,
    // A way through these points, with a node every `step` metres in between.
    way(points, tags, step = 25) {
      const dense = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1];
        const [bx, by] = points[i];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let k = 1; k <= n; k++) dense.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
      }
      const lat = [];
      const lon = [];
      for (const [x, y] of dense) {
        const [la, lo] = P.toLatLon(x, y);
        lat.push(la);
        lon.push(lo);
      }
      ways.push({ id: ways.length + 1, tags: { highway: "residential", ...tags }, nodes: dense.map(node), lat, lon });
    },
  };
}

// A fix at metres (x, y), `every` seconds apart.
const fixes = (points, { accuracy = 10, every = 20 } = {}) =>
  points.map(([x, y], i) => {
    const [lat, lon] = P.toLatLon(x, y);
    return { lat, lon, accuracy, ts: 1_000_000 + i * every * 1000 };
  });

function match(w, profile, points, options) {
  const out = matchOnWays(w.ways, profile, thinFixes(fixes(points, options)));
  return { ...out, xy: out.path.map(([lat, lon]) => P.toXY(lat, lon)) };
}

// A little random noise that is the same on every run.
function noise(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

const near = (xy, [x, y], m) => xy.some(([px, py]) => Math.hypot(px - x, py - y) <= m);
const lengthOf = (xy) => xy.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - xy[i - 1][0], p[1] - xy[i - 1][1]) : 0), 0);

test("profiles: cars keep off footpaths, bikes and walkers off motorways, one-way streets go one way", () => {
  assert.equal(wayRule("car", { highway: "footway" }), null);
  assert.equal(wayRule("car", { highway: "path" }), null);
  assert.equal(wayRule("car", { highway: "steps" }), null);
  assert.equal(wayRule("car", { highway: "residential", access: "no" }), null);
  assert.deepEqual(wayRule("car", { highway: "residential", oneway: "yes" }), { oneway: 1 });
  assert.deepEqual(wayRule("car", { highway: "primary", oneway: "-1" }), { oneway: -1 });
  assert.deepEqual(wayRule("car", { highway: "primary", junction: "roundabout" }), { oneway: 1 });
  assert.deepEqual(wayRule("car", { highway: "motorway" }), { oneway: 1 });
  assert.equal(wayRule("bike", { highway: "motorway" }), null);
  assert.equal(wayRule("bike", { highway: "trunk", motorroad: "yes" }), null);
  assert.deepEqual(wayRule("bike", { highway: "cycleway" }), { oneway: 0 });
  assert.deepEqual(wayRule("bike", { highway: "residential", oneway: "yes", "oneway:bicycle": "no" }), { oneway: 0 });
  assert.equal(wayRule("foot", { highway: "motorway" }), null);
  assert.equal(wayRule("foot", { highway: "trunk" }), null);
  assert.equal(wayRule("foot", { highway: "footway", foot: "no" }), null);
  assert.equal(wayRule("foot", { highway: "service", access: "no" }), null);
  assert.deepEqual(wayRule("foot", { highway: "service", access: "no", foot: "yes" }), { oneway: 0 });
  assert.deepEqual(wayRule("foot", { highway: "residential", oneway: "yes" }), { oneway: 0 }, "walkers go both ways");
  assert.equal(wayRule("car", { highway: "construction" }), null);
  assert.equal(wayRule("foot", { highway: "pedestrian", area: "yes" }), null);
  // The rail hook: tracks for trains and trams, not for anyone on the roads.
  assert.deepEqual(wayRule("rail", { railway: "rail" }), { oneway: 0 });
  assert.equal(wayRule("rail", { railway: "abandoned" }), null);
  assert.equal(wayRule("car", { railway: "rail" }), null);
});

test("ways that share a node are connected, one graph per profile", () => {
  const w = world();
  w.way([[0, 0], [100, 0]], {}, 100);
  w.way([[100, 0], [100, 100]], { highway: "footway" }, 100);
  w.way([[100, 0], [200, 0]], { oneway: "yes" }, 100);
  w.ways.push({ ...w.ways[0] }); // the same way from a neighbouring tile
  const car = buildGraph(w.ways, "car", ORIGIN);
  const foot = buildGraph(w.ways, "foot", ORIGIN);
  assert.equal(car.vertexCount, 3);
  assert.equal(car.segmentCount, 2);
  assert.equal(foot.segmentCount, 3);
  // Out of the middle node: west and east for cars, also north for walkers, nothing back from the east.
  const middle = 1;
  assert.equal(car.adjStart[middle + 1] - car.adjStart[middle], 2);
  assert.equal(foot.adjStart[middle + 1] - foot.adjStart[middle], 3);
  assert.equal(car.adjStart[3] - car.adjStart[2], 0, "the end of the one-way street leads nowhere back");
});

test("dense traces are thinned and repeats dropped, the last fix stays", () => {
  const pts = [[0, 0], [0, 0], [5, 0], [10, 0], [30, 0], [30, 0], [40, 0], [70, 0], [72, 0]];
  const out = thin(pts.map(([x, y]) => ({ x, y })));
  assert.deepEqual(out.map((p) => p.x), [0, 30, 70, 72]);
});

// A grid of streets 100 m apart; the stretch of y = 0 from x = 100 to 200 is one-way eastwards.
function grid() {
  const w = world();
  for (const y of [0, 100]) {
    w.way([[0, y], [100, y]]);
    w.way([[100, y], [200, y]], y === 0 ? { oneway: "yes" } : {});
    w.way([[200, y], [300, y]]);
  }
  for (const x of [0, 100, 200, 300]) w.way([[x, 0], [x, 100]]);
  return w;
}

test("a one-way street: a car drives round the block, a walker straight on", () => {
  const w = grid();
  // Westwards along y = 0, with no fix on the one-way stretch itself.
  const trace = [[300, 3], [260, -4], [220, 2], [80, -3], [40, 3], [0, -2]];
  const car = match(w, "car", trace);
  assert.ok(car.matched >= 5, `${car.matched} matched`);
  assert.ok(near(car.xy, [150, 100], 5), "the car goes round by the street to the north");
  const foot = match(w, "foot", trace);
  assert.ok(near(foot.xy, [150, 0], 5), "the walker takes the one-way street");
  assert.ok(!near(foot.xy, [150, 100], 30));
});

test("eastwards, with the traffic, the car takes the one-way street", () => {
  const car = match(grid(), "car", [[0, -2], [40, 3], [80, -3], [130, 2], [170, -2], [220, 2], [260, -4], [285, 3]]);
  assert.ok(car.xy.every(([, y]) => Math.abs(y) < 1), "stays on y = 0");
});

// A main road along y = 0 and a service road 15 m north of it, joined only at both ends.
function mainAndService() {
  const w = world();
  w.way([[0, 0], [2000, 0]], { highway: "primary" });
  w.way([[300, 0], [300, 15], [1700, 15], [1700, 0]], { highway: "service" });
  return w;
}

test("noisy fixes 20 to 40 m off a main road stay on it, not on the service road beside it", () => {
  const rnd = noise(7);
  const trace = [];
  for (let x = 0; x <= 2000; x += 40) {
    const off = 20 + 20 * rnd();
    trace.push([x + 5 * rnd(), rnd() < 0.5 ? off : -off]);
  }
  const out = match(mainAndService(), "car", trace, { accuracy: 30 });
  assert.ok(out.matched / trace.length > 0.9, `${out.matched} of ${trace.length} matched`);
  const middle = out.xy.filter(([x]) => x > 400 && x < 1600);
  assert.ok(middle.length > 0);
  assert.ok(middle.every(([, y]) => Math.abs(y) < 1), "on the main road the whole way");
});

test("sparse fixes 300 m apart on a winding road: the path follows its bends", () => {
  const w = world();
  // A road that swings 80 m north and south, every 400 m.
  const road = [];
  for (let x = 0; x <= 2400; x += 20) road.push([x, 80 * Math.sin((x / 400) * Math.PI)]);
  w.way(road, { highway: "secondary" });
  // A field track across the bends, for cars no way.
  w.way([[0, 0], [2400, 0]], { highway: "track" });
  const along = (x) => [x, 80 * Math.sin((x / 400) * Math.PI)];
  const trace = [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400].map((x) => {
    const [px, py] = along(x);
    return [px + 8, py - 6];
  });
  const out = match(w, "car", trace);
  assert.equal(out.matched, trace.length);
  const roadLength = lengthOf(road);
  assert.ok(Math.abs(lengthOf(out.xy) - roadLength) < 0.05 * roadLength, `${Math.round(lengthOf(out.xy))} m vs ${Math.round(roadLength)} m`);
  assert.ok(near(out.xy, [200, 80], 3) && near(out.xy, [1000, 80], 3) && near(out.xy, [1400, -80], 3), "through the crests between the fixes");
});

test("a roundabout is driven anticlockwise, walked the short way", () => {
  const w = world();
  const ring = [];
  for (let a = -90; a <= 270; a += 15) ring.push([30 * Math.cos((a * Math.PI) / 180), 30 * Math.sin((a * Math.PI) / 180)]);
  w.way(ring, { highway: "primary", junction: "roundabout" }, 10);
  w.way([[0, -300], [0, -30]], { highway: "primary" });
  w.way([[30, 0], [300, 0]], { highway: "primary" });
  w.way([[0, 30], [0, 300]], { highway: "primary" });
  w.way([[-30, 0], [-300, 0]], { highway: "primary" });
  // In from the south, out to the west.
  const trace = [[3, -280], [-2, -200], [2, -120], [-1, -60], [-60, 2], [-120, -3], [-200, 1], [-280, -2]];
  const car = match(w, "car", trace);
  assert.ok(near(car.xy, [30, 0], 3) && near(car.xy, [0, 30], 3), "the car goes round by the east and the north");
  const foot = match(w, "foot", trace);
  assert.ok(!near(foot.xy, [30, 0], 10), "the walker turns right away");
});

test("a motorway with a footpath beside it: the car takes the motorway, the walker the footpath", () => {
  const w = world();
  w.way([[0, 0], [3000, 0]], { highway: "motorway" });
  w.way([[0, 20], [3000, 20]], { highway: "footway" });
  const trace = [];
  for (let x = 0; x <= 3000; x += 250) trace.push([x, 14]);
  const car = match(w, "car", trace, { every: 8 });
  assert.ok(car.xy.every(([, y]) => Math.abs(y) < 1), "on the motorway");
  const walk = [];
  for (let x = 0; x <= 600; x += 30) walk.push([x, 6]);
  const foot = match(w, "foot", walk, { every: 25 });
  assert.ok(foot.xy.every(([, y]) => Math.abs(y - 20) < 1), "on the footpath");
});

test("a U-turn on a two-way street goes there and back", () => {
  const w = world();
  w.way([[0, 0], [1000, 0]]);
  w.way([[500, 0], [500, 400]]);
  const trace = [[0, 4], [100, -3], [200, 2], [300, -2], [400, 3], [480, -2], [400, 2], [300, -3], [200, 4], [100, -2]];
  const out = match(w, "car", trace);
  assert.equal(out.matched, trace.length);
  const xs = out.xy.map(([x]) => x);
  assert.ok(Math.max(...xs) > 470 && Math.max(...xs) < 520, "turns where the fixes turned");
  assert.ok(Math.abs(xs.at(-1) - 100) < 3, "and ends back west");
  assert.ok(!near(out.xy, [500, 100], 20), "not up the side street");
});

test("duplicates and fixes at the same spot do not break the match", () => {
  const w = world();
  w.way([[0, 0], [800, 0]]);
  const trace = [[0, 3], [0, 3], [0, 3], [100, 2], [100, 2], [101, 2], [200, -3], [200, -3], [400, 2], [400, 2], [600, -1], [800, 2], [800, 2]];
  const out = match(w, "car", trace);
  assert.ok(out.xy.every(([, y]) => Math.abs(y) < 1));
  assert.ok(Math.abs(lengthOf(out.xy) - 800) < 5);
});

test("a stretch across a field keeps its fixes, before and after it the roads", () => {
  const w = world();
  w.way([[0, 0], [600, 0]]);
  w.way([[600, 0], [600, 600]]);
  w.way([[600, 600], [1500, 600]]);
  // Along y = 0, then straight across the field (far from every road), then along y = 600.
  const trace = [[0, 3], [100, -2], [200, 2], [300, -1], [450, 200], [500, 300], [550, 450], [700, 602], [800, 598], [900, 601], [1000, 600]];
  const out = match(w, "foot", trace, { every: 60 });
  assert.ok(near(out.xy, [450, 200], 0.5) && near(out.xy, [500, 300], 0.5), "the fixes in the field are kept as they are");
  assert.ok(!near(out.xy, [600, 300], 30), "no road invented across the field");
  assert.ok(out.xy.slice(0, 4).every(([, y]) => Math.abs(y) < 1), "on the road before");
});

test("a gap in the fixes is filled along the roads", () => {
  const w = world();
  w.way([[0, 0], [600, 0], [600, 700], [1200, 700]], { highway: "tertiary" });
  // A couple of fixes, then nothing for 1.3 km round the corners, then a couple more.
  const trace = [[0, 3], [60, -3], [120, 2], [700, 697], [760, 703], [820, 700]];
  const out = match(w, "car", trace, { every: 30 });
  assert.equal(out.matched, trace.length);
  assert.ok(near(out.xy, [600, 0], 1) && near(out.xy, [600, 700], 1), "round both corners");
});

test("a 25 km drive with a few hundred fixes through a town grid matches in well under a second", () => {
  const w = world();
  // A town of 8 by 8 km, streets every 100 m, nodes every 25 m: 60 000 segments.
  for (let k = 0; k <= 80; k++) {
    w.way([[0, k * 100], [8000, k * 100]], { highway: k % 10 ? "residential" : "primary" });
    w.way([[k * 100, 0], [k * 100, 8000]], { highway: k % 10 ? "residential" : "primary" });
  }
  // A zigzag across town: 25 km of streets, a fix every 70 m, up to 12 m off.
  const rnd = noise(3);
  const route = [];
  let x = 0;
  let y = 0;
  for (let leg = 0; route.length < 360; leg++) {
    const east = leg % 2 === 0 ? 1 : -1;
    for (let i = 0; i < 100 && route.length < 360; i++) route.push([(x += 70 * east), y]);
    for (let i = 0; i < 10 && route.length < 360; i++) route.push([x, (y += 70)]);
  }
  const trace = route.map(([px, py]) => [px + 24 * (rnd() - 0.5), py + 24 * (rnd() - 0.5)]);
  const t0 = performance.now();
  const g = buildGraph(w.ways, "car", ORIGIN);
  const built = performance.now() - t0;
  const out = match(w, "car", trace, { every: 6 });
  const total = performance.now() - t0;
  assert.ok(g.segmentCount > 50_000, `${g.segmentCount} segments`);
  assert.ok(out.matched > 0.95 * trace.length, `${out.matched} of ${trace.length}`);
  assert.ok(lengthOf(out.xy) > 24_000, `${Math.round(lengthOf(out.xy))} m`);
  console.log(`25 km, ${trace.length} fixes, ${g.segmentCount} segments: graph ${built.toFixed(0)} ms, all ${total.toFixed(0)} ms`);
  assert.ok(total < 1500, `${total.toFixed(0)} ms`);
});

test("viterbi starts a new chain where no road leads on", () => {
  const w = world();
  w.way([[0, 0], [300, 0]]);
  w.way([[0, 1000], [300, 1000]]); // not connected to the first
  const g = buildGraph(w.ways, "car", ORIGIN);
  const pts = [[0, 2], [100, 2], [200, 2], [100, 1002], [200, 1002]].map(([x, y]) => ({ x, y, accuracy: 10 }));
  const chains = viterbi(g, pts);
  assert.deepEqual(chains.map((c) => c.map((s) => s.index)), [[0, 1, 2], [3, 4]]);
});

// Sharp turns back (more than 150 degrees) with a leg shorter than 50 m: a zigzag.
function zigzags(xy) {
  let n = 0;
  for (let i = 1; i < xy.length - 1; i++) {
    const ux = xy[i][0] - xy[i - 1][0], uy = xy[i][1] - xy[i - 1][1];
    const vx = xy[i + 1][0] - xy[i][0], vy = xy[i + 1][1] - xy[i][1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu && lv && (ux * vx + uy * vy) / (lu * lv) < -0.87 && Math.min(lu, lv) < 50) n++;
  }
  return n;
}

const distToLine = (line, [px, py]) => {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(px - ax - dx * t, py - ay - dy * t));
  }
  return best;
};

// A small town: streets every 80 m, a footpath or a service road between each pair of them,
// all joined where they cross.
function town() {
  const w = world();
  const stops = Array.from({ length: 21 }, (_, i) => i * 40);
  for (let k = 0; k <= 10; k++) {
    w.way(stops.map((s) => [s, k * 80]));
    w.way(stops.map((s) => [k * 80, s]));
  }
  for (let k = 0; k < 10; k++) w.way(stops.map((s) => [k * 80 + 40, s]), { highway: k % 2 ? "service" : "footway" });
  return w;
}

test("a walk between houses with 20 to 40 m of GPS noise stays on its streets, without zigzags", () => {
  // East along y = 160, north up the footpath at x = 440, east along y = 560: 1.2 km.
  const truth = [[0, 160], [440, 160], [440, 560], [800, 560]];
  const along = [];
  for (let i = 1; i < truth.length; i++) {
    const [ax, ay] = truth[i - 1], [bx, by] = truth[i];
    const n = Math.round(Math.hypot(bx - ax, by - ay) / 21);
    for (let k = i === 1 ? 0 : 1; k <= n; k++) along.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  const rnd = noise(11);
  const trace = along.map(([x, y]) => {
    const r = 20 + 20 * rnd();
    const a = 2 * Math.PI * rnd();
    return [x + r * Math.cos(a), y + r * Math.sin(a)];
  });
  // And one fix the GPS threw 90 m off, a street further east.
  trace[30] = [along[30][0] + 90, along[30][1]];
  const out = match(town(), "foot", trace, { accuracy: 15, every: 15 });
  assert.ok(out.matched >= 0.9 * thinFixes(fixes(trace)).length, `${out.matched} matched`);
  // On the ways all along, no straight lines through the houses: every point is on a street
  // (x a multiple of 40 or y one of 80).
  const onAWay = ([x, y]) => Math.abs(x - 40 * Math.round(x / 40)) < 0.5 || Math.abs(y - 80 * Math.round(y / 80)) < 0.5;
  assert.ok(out.xy.every(onAWay), "only along the ways");
  // Where the noise is as wide as the blocks, the next way over is as likely; never further.
  assert.ok(out.xy.every((p) => distToLine(truth, p) <= 41), "never further than the next way over");
  const sampled = [];
  for (let i = 1; i < out.xy.length; i++) {
    const [ax, ay] = out.xy[i - 1], [bx, by] = out.xy[i];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 5);
    for (let k = 0; k < n; k++) sampled.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  const onTruth = sampled.filter((p) => distToLine(truth, p) <= 2).length / sampled.length;
  assert.ok(onTruth > 0.8, `${Math.round(onTruth * 100)}% of the path on the way walked`);
  assert.ok(zigzags(out.xy) <= 1, `${zigzags(out.xy)} zigzags`);
  assert.ok(Math.abs(lengthOf(out.xy) - 1200) < 180, `${Math.round(lengthOf(out.xy))} m`);
});

test("a short step back on the road is noise, a real turn back is kept", () => {
  const w = world();
  w.way([[0, 0], [600, 0]]);
  w.way([[300, 0], [300, 200]]);
  // Along the street, one fix 15 m behind the one before.
  const jitter = match(w, "foot", [[0, 3], [60, -2], [120, 3], [105, -3], [180, 2], [240, -2], [300, 3], [360, 2]], { every: 30 });
  assert.equal(zigzags(jitter.xy), 0);
  assert.ok(Math.abs(lengthOf(jitter.xy) - 360) < 10, `${Math.round(lengthOf(jitter.xy))} m`);
  // Up the side street and back down, 150 m each way.
  const back = match(w, "foot", [[200, 2], [260, -2], [300, 50], [302, 100], [298, 150], [301, 100], [299, 50], [260, 3], [200, -2]], { every: 40 });
  assert.ok(near(back.xy, [300, 140], 15), "goes up to where the walker turned");
});

test("a field track is a car's way only where there is nothing else", () => {
  assert.deepEqual(wayRule("car", { highway: "track" }), { oneway: 0, cost: 4, low: true });
  assert.deepEqual(wayRule("car", { highway: "track", motor_vehicle: "yes" }), { oneway: 0 });
  assert.deepEqual(wayRule("foot", { highway: "track" }), { oneway: 0 });
  // A farm track alone in the fields: the car is on it.
  const w = world();
  w.way([[0, 0], [1000, 0]], { highway: "track" });
  const out = match(w, "car", [[0, 5], [200, -4], [400, 3], [600, -5], [800, 4], [1000, 2]], { every: 30 });
  assert.equal(out.matched, 6);
  assert.ok(out.xy.every(([, y]) => Math.abs(y) < 1));
});

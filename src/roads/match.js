import { BACKWARD, FORWARD, segmentsNear } from "./graph.js";

// Map matching with a hidden Markov model after Newson & Krumm (2009), "Hidden Markov Map
// Matching Through Noise and Sparseness". Each fix has a few candidate spots on the roads near
// it; a spot is likely when it is close to the fix (emission), a step from one spot to the next
// is likely when the way along the roads is about as long as the straight line between the two
// fixes (transition). Viterbi picks the likeliest chain of spots, the roads between them are
// the path. Where no road leads on, the chain ends and a new one starts with the next fix.

export const TUNING = {
  // Fixes closer than this to the last one kept add nothing but noise and work.
  thinM: 25,
  // Search radius: twice what the GPS said it was accurate to, within these bounds.
  radius: { min: 15, max: 80, unknownAccuracyM: 25 },
  maxCandidates: 8,
  // Standard deviation of the GPS error (emission), from the accuracy, within these bounds.
  sigma: { min: 5, max: 20, unknownM: 10 },
  // How much longer than the straight line the way along the roads may be before a step
  // gets unlikely: e^(-diff/beta). Grows a little with the distance between the fixes, sparse
  // fixes on winding roads are long ways round by nature.
  beta: { baseM: 20, perM: 0.05 },
  // How far a route between two fixes is searched.
  bound: { factor: 3, extraM: 500 },
  // A step back on a one-way street this short is GPS jitter, not a wrong-way drive.
  jitterM: 12,
  // Faster than this between two fixes is not the way the phone went (with timestamps).
  maxSpeedMs: { car: 60, bike: 25, foot: 8, rail: 90 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hasAccuracy = (p) => Number.isFinite(p.accuracy) && p.accuracy > 0;
export const radiusFor = (p) => clamp(2 * (hasAccuracy(p) ? p.accuracy : TUNING.radius.unknownAccuracyM), TUNING.radius.min, TUNING.radius.max);
const sigmaFor = (p) => (hasAccuracy(p) ? clamp(p.accuracy, TUNING.sigma.min, TUNING.sigma.max) : TUNING.sigma.unknownM);

// Dense traces get thinned, duplicates dropped; the last fix always stays.
export function thin(points, minM = TUNING.thinM) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const last = out[out.length - 1];
    if (!last) {
      out.push(p);
      continue;
    }
    const d = Math.hypot(p.x - last.x, p.y - last.y);
    if (d >= minM || (i === points.length - 1 && d > 1)) out.push(p);
  }
  return out;
}

// The candidate spots of one fix: projections onto the segments around it. A projection onto
// the end of a segment is dropped when a segment at that end comes closer (the next stretch of
// the same road), so the few candidates left are different roads, not one road many times.
function candidatesOf(g, p) {
  let near = segmentsNear(g, p.x, p.y, radiusFor(p));
  // A fix far off every road within its accuracy may still be next to one: look a bit wider.
  if (!near.length) near = segmentsNear(g, p.x, p.y, TUNING.radius.max);
  if (!near.length) return [];
  const atEnd = (c) => (c.t <= 1e-9 ? g.segA[c.seg] : c.t >= 1 - 1e-9 ? g.segB[c.seg] : -1);
  const kept = near.filter((c) => {
    const v = atEnd(c);
    if (v < 0) return true;
    return !near.some((o) => o !== c && o.d < c.d - 1e-6 && (g.segA[o.seg] === v || g.segB[o.seg] === v));
  });
  kept.sort((a, b) => a.d - b.d);
  const out = [];
  for (const c of kept) {
    if (out.some((o) => Math.abs(o.x - c.x) < 1 && Math.abs(o.y - c.y) < 1)) continue;
    out.push(c);
    if (out.length >= TUNING.maxCandidates) break;
  }
  return out;
}

// ---- shortest ways ----

class Heap {
  constructor() {
    this.keys = new Float64Array(256);
    this.vals = new Int32Array(256);
    this.size = 0;
  }
  push(key, val) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
      const vals = new Int32Array(this.size * 2);
      vals.set(this.vals);
      this.vals = vals;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.vals[i] = this.vals[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }
  // Removes the smallest; read topKey/topVal before.
  pop() {
    const key = this.keys[--this.size];
    const val = this.vals[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.keys[i] = this.keys[child];
      this.vals[i] = this.vals[child];
      i = child;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }
}

// Search state per graph, reused: a stamp per vertex says whether its distance is from this run,
// so nothing has to be cleared between the many searches of one match.
function searchState(g) {
  if (!g.search) {
    g.search = {
      dist: new Float64Array(g.vertexCount),
      stamp: new Int32Array(g.vertexCount),
      done: new Int32Array(g.vertexCount),
      predV: new Int32Array(g.vertexCount),
      predS: new Int32Array(g.vertexCount),
      gen: 0,
      heap: new Heap(),
    };
  }
  return g.search;
}

// Where a candidate leaves its segment: [vertex, metres to get there].
function exitsOf(g, c) {
  const len = g.segLen[c.seg];
  const out = [];
  if (g.segDir[c.seg] & FORWARD) out.push([g.segB[c.seg], (1 - c.t) * len]);
  if (g.segDir[c.seg] & BACKWARD) out.push([g.segA[c.seg], c.t * len]);
  return out;
}

// Where a candidate is entered from: [vertex, metres from there to the spot].
function entriesOf(g, c) {
  const len = g.segLen[c.seg];
  const out = [];
  if (g.segDir[c.seg] & FORWARD) out.push([g.segA[c.seg], c.t * len]);
  if (g.segDir[c.seg] & BACKWARD) out.push([g.segB[c.seg], (1 - c.t) * len]);
  return out;
}

// Along the same segment, without leaving it, or Infinity.
function sameSegment(g, a, b) {
  if (a.seg !== b.seg) return Infinity;
  const len = g.segLen[a.seg];
  const ahead = (b.t - a.t) * len;
  const dir = g.segDir[a.seg];
  if (ahead >= 0 && dir & FORWARD) return ahead;
  if (ahead <= 0 && dir & BACKWARD) return -ahead;
  // Jitter backwards on a one-way street: standing still.
  if (Math.abs(ahead) <= TUNING.jitterM) return 0;
  return Infinity;
}

// Dijkstra from one candidate to all of `targets`, up to `bound` metres. Returns the distances.
function routesFrom(g, from, targets, bound) {
  const st = searchState(g);
  const gen = ++st.gen;
  const { dist, stamp, done, predV, predS, heap } = st;
  heap.size = 0;
  const wanted = new Map();
  targets.forEach((c, j) => {
    for (const [v, extra] of entriesOf(g, c)) {
      if (!wanted.has(v)) wanted.set(v, []);
      wanted.get(v).push([j, extra]);
    }
  });
  let remaining = wanted.size;
  for (const [v, d] of exitsOf(g, from)) {
    if (stamp[v] !== gen || d < dist[v]) {
      stamp[v] = gen;
      dist[v] = d;
      predV[v] = -1;
      predS[v] = from.seg;
      heap.push(d, v);
    }
  }
  while (heap.size && remaining > 0) {
    const d = heap.keys[0];
    const v = heap.vals[0];
    heap.pop();
    if (d > bound) break;
    if (done[v] === gen || d > dist[v]) continue;
    done[v] = gen;
    if (wanted.has(v)) remaining--;
    for (let k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) {
      const w = g.adjTo[k];
      const nd = d + g.segLen[g.adjSeg[k]];
      if (nd > bound) continue;
      if (stamp[w] !== gen || nd < dist[w]) {
        stamp[w] = gen;
        dist[w] = nd;
        predV[w] = v;
        predS[w] = g.adjSeg[k];
        heap.push(nd, w);
      }
    }
  }
  const out = targets.map((c) => sameSegment(g, from, c));
  for (const [v, list] of wanted) {
    if (done[v] !== gen) continue;
    for (const [j, extra] of list) out[j] = Math.min(out[j], dist[v] + extra);
  }
  return out;
}

// The way from candidate a to b as points [x, y], both spots included.
function routeGeometry(g, a, b, bound) {
  const direct = sameSegment(g, a, b);
  const viaGraph = routesFrom(g, a, [b], bound)[0];
  if (direct <= viaGraph + 1e-6) return direct === 0 ? [[b.x, b.y]] : [[a.x, a.y], [b.x, b.y]];
  // routesFrom left the search tree of this pair behind: walk it back from b's best entry.
  const st = g.search;
  let best = -1;
  let bestD = Infinity;
  for (const [v, extra] of entriesOf(g, b)) {
    if (st.done[v] === st.gen && st.dist[v] + extra < bestD) {
      bestD = st.dist[v] + extra;
      best = v;
    }
  }
  const chain = [];
  for (let v = best; v >= 0; v = st.predV[v]) chain.push(v);
  chain.reverse();
  return [[a.x, a.y], ...chain.map((v) => [g.x[v], g.y[v]]), [b.x, b.y]];
}

// ---- Viterbi ----

const betaFor = (straight) => TUNING.beta.baseM + TUNING.beta.perM * straight;
const boundFor = (straight) => TUNING.bound.factor * straight + TUNING.bound.extraM;

// Matches points ({ x, y, accuracy?, ts? } in the graph's metres, already thinned) onto the
// graph. Returns chains of consecutive points that are on the roads, each with the chosen
// candidate per point; points between chains matched nothing.
export function viterbi(g, points) {
  const maxSpeed = TUNING.maxSpeedMs[g.profile] ?? Infinity;
  const chains = [];
  let steps = null; // [{ index, cands, score, back }]
  const close = () => {
    if (steps?.length) {
      let j = 0;
      const last = steps[steps.length - 1];
      for (let k = 1; k < last.cands.length; k++) if (last.score[k] > last.score[j]) j = k;
      const chosen = new Array(steps.length);
      for (let s = steps.length - 1; s >= 0; s--) {
        chosen[s] = { index: steps[s].index, cand: steps[s].cands[j] };
        j = steps[s].back[j];
      }
      chains.push(chosen);
    }
    steps = null;
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const cands = candidatesOf(g, p);
    if (!cands.length) {
      close();
      continue;
    }
    const sigma = sigmaFor(p);
    const emission = cands.map((c) => -0.5 * (c.d / sigma) ** 2);
    if (!steps) {
      steps = [{ index: i, cands, score: emission, back: cands.map(() => -1) }];
      continue;
    }
    const prev = steps[steps.length - 1];
    const q = points[prev.index];
    const straight = Math.hypot(p.x - q.x, p.y - q.y);
    const beta = betaFor(straight);
    let bound = boundFor(straight);
    if (Number.isFinite(p.ts) && Number.isFinite(q.ts) && p.ts > q.ts) bound = Math.min(bound, Math.max(straight + 100, ((p.ts - q.ts) / 1000) * maxSpeed));
    const score = cands.map(() => -Infinity);
    const back = cands.map(() => -1);
    prev.cands.forEach((from, a) => {
      if (prev.score[a] === -Infinity) return;
      const routes = routesFrom(g, from, cands, bound);
      routes.forEach((route, b) => {
        if (!(route <= bound)) return;
        const s = prev.score[a] - Math.abs(route - straight) / beta + emission[b];
        if (s > score[b]) {
          score[b] = s;
          back[b] = a;
        }
      });
    });
    if (score.every((s) => s === -Infinity)) {
      // No road leads from the last fix to this one: end the chain, start again here.
      close();
      steps = [{ index: i, cands, score: emission, back: cands.map(() => -1) }];
      continue;
    }
    // Keeps the numbers small over a long trace; only differences matter.
    const top = Math.max(...score);
    steps.push({ index: i, cands, score: score.map((s) => s - top), back });
  }
  close();
  return chains;
}

// The road geometry of one chain, [x, y] points, and its length.
export function chainGeometry(g, points, chain) {
  const out = [[chain[0].cand.x, chain[0].cand.y]];
  for (let k = 1; k < chain.length; k++) {
    const q = points[chain[k - 1].index];
    const p = points[chain[k].index];
    const bound = boundFor(Math.hypot(p.x - q.x, p.y - q.y));
    const part = routeGeometry(g, chain[k - 1].cand, chain[k].cand, bound);
    for (const pt of part) {
      const last = out[out.length - 1];
      if (Math.abs(last[0] - pt[0]) > 0.05 || Math.abs(last[1] - pt[1]) > 0.05) out.push(pt);
    }
  }
  return out;
}

export const lengthXY = (line) => line.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]) : 0), 0);

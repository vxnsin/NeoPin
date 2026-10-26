import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// The dashboard loads this file as a plain script, so it is run the same way here.
const file = new URL("../public/assets/scripts/cluster.js", import.meta.url);
const run = vm.runInNewContext(`${fs.readFileSync(file, "utf8")}\nclusterPoints;`);
// Results come from another realm, a JSON round trip makes them comparable.
const clusterPoints = (...args) => JSON.parse(JSON.stringify(run(...args)));

const pt = (id, x, y) => ({ id, x, y });
const ids = (groups) => groups.map((g) => g.ids);

test("far apart points stay alone", () => {
  const groups = clusterPoints([pt("a", 0, 0), pt("b", 200, 0), pt("c", 0, 300)], 56);
  assert.deepEqual(ids(groups), [["a"], ["b"], ["c"]]);
});

test("close points share a group at their centre", () => {
  const groups = clusterPoints([pt("a", 10, 10), pt("b", 30, 10), pt("c", 400, 400)], 56);
  assert.deepEqual(ids(groups), [["a", "b"], ["c"]]);
  assert.equal(groups[0].x, 20);
  assert.equal(groups[0].y, 10);
});

test("points on the very same spot are grouped", () => {
  const groups = clusterPoints([pt("a", 5, 5), pt("b", 5, 5), pt("c", 5, 5)], 56);
  assert.deepEqual(ids(groups), [["a", "b", "c"]]);
});

test("the threshold is exclusive and measured to the seed", () => {
  const groups = clusterPoints([pt("a", 0, 0), pt("b", 56, 0), pt("c", 40, 0)], 56);
  assert.deepEqual(ids(groups), [["a", "c"], ["b"]]);
});

test("kept points are neither merged nor absorbed", () => {
  const groups = clusterPoints([pt("a", 0, 0), pt("b", 10, 0), pt("c", 20, 0)], 56, new Set(["b"]));
  assert.deepEqual(ids(groups), [["a", "c"], ["b"]]);
  assert.deepEqual(clusterPoints([pt("a", 0, 0), pt("b", 10, 0)], 56, new Set(["a", "b"])).map((g) => g.ids.length), [1, 1]);
});

test("empty input gives no groups and every point lands in exactly one group", () => {
  assert.deepEqual(clusterPoints([], 56), []);
  const points = Array.from({ length: 40 }, (_, i) => pt(`p${i}`, (i * 37) % 300, (i * 91) % 300));
  const all = clusterPoints(points, 56).flatMap((g) => g.ids);
  assert.equal(all.length, 40);
  assert.equal(new Set(all).size, 40);
});

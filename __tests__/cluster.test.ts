import { CLUSTER_RADIUS_PX, CLUSTER_SCRIPT, clusterPins, type ClusterPin } from "../lib/cluster";
import { buildMapHtml } from "../lib/mapHtml";

const pin = (key: string, x: number, y: number, owner = key, fixed = false): ClusterPin => ({ key, x, y, owner, fixed });

// The function as the WebView sees it: cut out of the generated page and evaluated.
function scriptFunction(): typeof clusterPins {
  const html = buildMapHtml(false, 0);
  const start = html.indexOf("function clusterPins(");
  expect(start).toBeGreaterThan(-1);
  expect(html).toContain(CLUSTER_SCRIPT);
  return new Function(`${CLUSTER_SCRIPT}; return clusterPins;`)();
}

test("pins closer than the radius share a cluster at their centroid", () => {
  const result = clusterPins([pin("a", 100, 100), pin("b", 140, 100), pin("c", 400, 400)], 56);
  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({ keys: ["a", "b"], x: 120, y: 100, owners: ["a", "b"] });
  expect(result[1].keys).toEqual(["c"]);
});

test("a person with two devices is one owner in the cluster", () => {
  const [group] = clusterPins([pin("1:phone", 0, 0, "u1"), pin("1:pad", 5, 5, "u1"), pin("2:phone", 10, 0, "u2")], CLUSTER_RADIUS_PX);
  expect(group.keys).toHaveLength(3);
  expect(group.owners).toEqual(["u1", "u2"]);
});

test("a fixed pin (the selected device) never joins a cluster", () => {
  const result = clusterPins([pin("a", 0, 0), pin("b", 10, 0, "b", true), pin("c", 20, 0)], 56);
  expect(result.map((g) => g.keys)).toEqual([["a", "c"], ["b"]]);
});

test("the result does not depend on the input order", () => {
  const pins = [pin("c", 90, 0), pin("a", 0, 0), pin("b", 40, 0)];
  expect(clusterPins(pins, 56)).toEqual(clusterPins([...pins].reverse(), 56));
});

test("the script embedded in the map page behaves like the TypeScript function", () => {
  const inPage = scriptFunction();
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let round = 0; round < 20; round++) {
    const pins = Array.from({ length: 30 }, (_, i) =>
      pin(`k${i}`, Math.round(random() * 400), Math.round(random() * 400), `o${Math.floor(random() * 8)}`, random() < 0.1)
    );
    expect(inPage(pins, CLUSTER_RADIUS_PX)).toEqual(clusterPins(pins, CLUSTER_RADIUS_PX));
  }
});

test("the map page wires clustering into sync and the zoom events", () => {
  const html = buildMapHtml(false, 0);
  expect(html).toContain("clusterPins(pins, CLUSTER_RADIUS)");
  expect(html).toContain('map.on("zoomend", layout)');
  expect(html).toContain("keyOf(d) === selectedId");
  expect(html).toContain(`var CLUSTER_RADIUS = ${CLUSTER_RADIUS_PX};`);
});

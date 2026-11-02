import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// The dashboard loads this file as a plain script, so it is run the same way here.
const source = fs.readFileSync(new URL("../public/assets/scripts/terrain.js", import.meta.url), "utf8");
const maplibregl = {
  LngLat: { convert: (p) => (Array.isArray(p) ? { lng: p[0], lat: p[1] } : p) },
};
function load(storage = {}) {
  const localStorage = {
    getItem: (key) => (key in storage ? storage[key] : null),
    setItem: (key, value) => (storage[key] = String(value)),
  };
  const context = { maplibregl, localStorage, requestAnimationFrame: (fn) => fn() };
  const api = vm.runInNewContext(
    `${source}\n({ TERRAIN, MAP3D_KEY, stored3d, store3d, applyTerrain, tiltCamera, watchPitch, followTerrain, tiltedCamera, UPRIGHT, terrainReady, refitWhenTerrain, pitch: () => terrainPitch });`,
    context
  );
  return { ...api, storage };
}
// Results come from another realm, a JSON round trip makes them comparable.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Just enough of a MapLibre map to see what the script does to the style and the camera.
function fakeMap() {
  const layers = [
    { id: "background", type: "background" },
    { id: "water", type: "fill", source: "openmaptiles", sourceLayer: "water" },
    { id: "building", type: "fill", source: "openmaptiles", sourceLayer: "building" },
    { id: "highway_minor", type: "line", source: "openmaptiles" },
    { id: "place_city", type: "symbol", source: "openmaptiles" },
  ];
  const sources = { openmaptiles: { type: "vector" } };
  const visibility = {};
  const gestures = { rotate: false, touchRotate: false, keyboard: false, touchPitch: true };
  const calls = [];
  const listeners = {};
  let terrain = null;
  const map = {
    layers, sources, visibility, gestures, calls, pitch: 0,
    getStyle: () => ({ layers }),
    getLayer: (id) => layers.find((l) => l.id === id),
    getSource: (id) => sources[id],
    addSource: (id, spec) => (sources[id] = spec),
    removeSource: (id) => delete sources[id],
    addLayer(layer, before) {
      const at = before ? layers.findIndex((l) => l.id === before) : -1;
      const entry = { ...layer, sourceLayer: layer["source-layer"] };
      if (at < 0) layers.push(entry);
      else layers.splice(at, 0, entry);
    },
    removeLayer: (id) => layers.splice(layers.findIndex((l) => l.id === id), 1),
    setLayoutProperty: (id, _name, value) => (visibility[id] = value),
    getTerrain: () => terrain,
    setTerrain: (spec) => (terrain = spec),
    dragRotate: { enable: () => (gestures.rotate = true), disable: () => (gestures.rotate = false) },
    touchZoomRotate: { enableRotation: () => (gestures.touchRotate = true), disableRotation: () => (gestures.touchRotate = false) },
    keyboard: { enableRotation: () => (gestures.keyboard = true), disableRotation: () => (gestures.keyboard = false) },
    touchPitch: { enable: () => (gestures.touchPitch = true), disable: () => (gestures.touchPitch = false) },
    getBearing: () => 20,
    getPitch: () => map.pitch,
    on: (event, fn) => (listeners[event] ||= []).push(fn),
    off: (event, fn) => (listeners[event] = (listeners[event] || []).filter((f) => f !== fn)),
    isSourceLoaded: () => true,
    fire: (event, e) => (listeners[event] || []).forEach((fn) => fn(e)),
    easeTo: (o) => calls.push({ method: "easeTo", args: [o] }),
    jumpTo: (o) => calls.push({ method: "jumpTo", args: [o] }),
    terrain: null,
    // A flat, square "projection": 100 px per degree at z12 around the padded centre.
    transform: {
      clone() {
        const t = {
          width: 1200, height: 800, padding: { top: 0, bottom: 0, left: 0, right: 0 },
          zoom: 0, center: { lng: 0, lat: 0 },
          get centerPoint() {
            return { x: (t.padding.left + t.width - t.padding.right) / 2, y: (t.padding.top + t.height - t.padding.bottom) / 2 };
          },
          setPadding: (p) => (t.padding = p), setPitch() {}, setZoom: (z) => (t.zoom = z), setCenter: (c) => (t.center = c),
          locationToScreenPoint(p) {
            const k = 100 * 2 ** (t.zoom - 12), c = t.centerPoint;
            return { x: c.x + (p.lng - t.center.lng) * k, y: c.y - (p.lat - t.center.lat) * k };
          },
          screenPointToLocation(p) {
            const k = 100 * 2 ** (t.zoom - 12), c = t.centerPoint;
            return { lng: t.center.lng + (p.x - c.x) / k, lat: t.center.lat - (p.y - c.y) / k };
          },
        };
        return t;
      },
    },
  };
  return map;
}

test("the terrain comes from the free Terrarium tiles, credited, and only up to z12", () => {
  const { applyTerrain } = load();
  const map = fakeMap();
  applyTerrain(map, true, false);
  for (const id of ["terrain-dem", "hillshade-dem"]) {
    assert.deepEqual(plain(map.sources[id]), {
      type: "raster-dem",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 12,
      attribution: "Terrain: Mapzen, AWS Open Data",
    });
  }
  assert.deepEqual(plain(map.getTerrain()), { source: "terrain-dem", exaggeration: 1.3 });
});

test("3D shades the hills under the buildings and pulls the buildings up under the labels", () => {
  const { applyTerrain, TERRAIN } = load();
  const map = fakeMap();
  applyTerrain(map, true, false);
  assert.deepEqual(map.layers.map((l) => l.id), ["background", "water", "hillshade", "building", "highway_minor", "building-3d", "place_city"]);
  const extruded = map.layers.find((l) => l.id === "building-3d");
  assert.equal(extruded.type, "fill-extrusion");
  assert.equal(extruded.sourceLayer, "building");
  assert.equal(extruded.minzoom, 14);
  assert.match(JSON.stringify(extruded.paint["fill-extrusion-height"]), /render_height/);
  assert.match(JSON.stringify(extruded.paint["fill-extrusion-base"]), /render_min_height/);
  assert.equal(extruded.paint["fill-extrusion-color"], TERRAIN.buildings.light);
  assert.equal(map.visibility.building, "none");
  assert.deepEqual(map.gestures, { rotate: true, touchRotate: true, keyboard: true, touchPitch: true });

  const dark = fakeMap();
  applyTerrain(dark, true, true);
  assert.equal(dark.layers.find((l) => l.id === "building-3d").paint["fill-extrusion-color"], TERRAIN.buildings.dark);
});

test("switching on twice adds nothing twice, off leaves the flat map as it was", () => {
  const { applyTerrain } = load();
  const map = fakeMap();
  const before = map.layers.map((l) => l.id);
  applyTerrain(map, true, false);
  applyTerrain(map, true, false);
  assert.equal(map.layers.filter((l) => l.id === "building-3d").length, 1);
  applyTerrain(map, false, false);
  assert.deepEqual(map.layers.map((l) => l.id), before);
  assert.deepEqual(Object.keys(map.sources), ["openmaptiles"]);
  assert.equal(map.getTerrain(), null);
  assert.equal(map.visibility.building, "visible");
  assert.deepEqual(map.gestures, { rotate: false, touchRotate: false, keyboard: false, touchPitch: true });
});

test("the switch is off by default and remembered per browser", () => {
  const first = load();
  assert.equal(first.stored3d(), false);
  first.store3d(true);
  assert.equal(first.storage[first.MAP3D_KEY], "on");
  assert.equal(load(first.storage).stored3d(), true);
  // A browser that refuses storage still gets a flat map and no error.
  const broken = vm.runInNewContext(`${source}\nstored3d();`, { maplibregl, localStorage: { getItem() { throw new Error("denied"); } } });
  assert.equal(broken, false);
});

test("the switch tilts to 55 degrees and back to flat facing north, instantly on opening", () => {
  const { tiltCamera, pitch } = load();
  const map = fakeMap();
  tiltCamera(map, true);
  assert.deepEqual(plain(map.calls[0]), { method: "easeTo", args: [{ pitch: 55, bearing: 20, duration: 700 }] });
  assert.equal(pitch(), 55);
  tiltCamera(map, false);
  assert.deepEqual(plain(map.calls[1].args[0]), { pitch: 0, bearing: 0, duration: 700 });
  tiltCamera(map, true, true);
  assert.deepEqual(plain(map.calls[2]), { method: "jumpTo", args: [{ pitch: 55, bearing: 20 }] });
});

test("a finger or the keyboard changes the pitch later fits keep, a camera move does not", () => {
  const { tiltCamera, watchPitch, pitch } = load();
  const map = fakeMap();
  watchPitch(map);
  tiltCamera(map, true);
  map.pitch = 3;
  map.fire("pitchend", {});
  assert.equal(pitch(), 55);
  map.pitch = 40;
  map.fire("pitchend", { originalEvent: {} });
  assert.equal(pitch(), 40);
});

test("tilted, a trip's points all land inside the padding", () => {
  const { tiltedCamera } = load();
  const map = fakeMap();
  const points = [[11, 47.5], [11.02, 47.52], [11.04, 47.5]];
  const padding = { top: 120, bottom: 80, left: 500, right: 110 };
  const camera = tiltedCamera(map, points, padding, { center: [11.02, 47.51], zoom: 16 }, 15);
  assert.ok(camera.zoom <= 15);
  const tr = map.transform.clone();
  tr.setPadding(padding);
  tr.setZoom(camera.zoom);
  tr.setCenter(camera.center);
  for (const p of points) {
    const at = tr.locationToScreenPoint(maplibregl.LngLat.convert(p));
    assert.ok(at.x >= padding.left - 1 && at.x <= 1200 - padding.right + 1, `x ${at.x}`);
    assert.ok(at.y >= padding.top - 1 && at.y <= 800 - padding.bottom + 1, `y ${at.y}`);
  }
});

test("a fit before the mountains are in runs again once they are, unless someone moved the map", () => {
  for (const moved of [false, true]) {
    const { applyTerrain, terrainReady, refitWhenTerrain } = load();
    const map = fakeMap();
    applyTerrain(map, true, false);
    assert.equal(terrainReady(map), false);
    let refits = 0;
    refitWhenTerrain(map, () => refits++);
    // A second fit while waiting replaces the first, it does not add one.
    refitWhenTerrain(map, () => (refits += 10));
    if (moved) map.fire("movestart", { originalEvent: {} });
    map.fire("idle", {});
    assert.equal(refits, 0, "DEM still loading");
    map.terrain = {};
    map.fire("idle", {});
    map.fire("idle", {});
    assert.equal(refits, moved ? 0 : 10);
  }
});

test("in 3D every marker is placed again after each frame, off it is left to MapLibre", () => {
  const { followTerrain } = load();
  const map = fakeMap();
  let terrain = null;
  map.getTerrain = () => terrain;
  const log = [];
  const pin = {
    setSubpixelPositioning: (on) => log.push("subpixel " + on),
    setOpacity: (...args) => log.push("opacity " + args.join(",")),
    getLngLat: () => ({ lng: 11, lat: 47.5 }),
    setLngLat: () => log.push("place"),
  };
  // A popup has no opacity of its own.
  const popupLog = [];
  const popup = { setSubpixelPositioning: () => popupLog.push("subpixel"), getLngLat: () => ({}), setLngLat: () => popupLog.push("place") };
  followTerrain(map, () => [pin, popup, null]);
  map.fire("render", {});
  assert.deepEqual(log, []);
  terrain = { source: "terrain-dem" };
  map.fire("render", {});
  map.fire("render", {});
  assert.deepEqual(log, ["subpixel true", "opacity 1,1", "place", "place"]);
  assert.deepEqual(popupLog, ["subpixel", "place", "place"]);
  terrain = null;
  map.fire("render", {});
  map.fire("render", {});
  assert.deepEqual(log.slice(4), ["subpixel false", "opacity ", "place"]);
});

test("every marker on the dashboard stands upright on its point", () => {
  const { UPRIGHT } = load();
  assert.deepEqual(plain(UPRIGHT), { pitchAlignment: "viewport", rotationAlignment: "viewport" });
  for (const name of ["dashboard.js", "timeline.js"]) {
    const code = fs.readFileSync(new URL("../public/assets/scripts/" + name, import.meta.url), "utf8");
    const markers = code.match(/new maplibregl\.Marker\(\{[^}]*\}/g) ?? [];
    assert.ok(markers.length > 0, name);
    for (const m of markers) assert.match(m, /\.\.\.UPRIGHT/, name);
  }
});

test("the dashboard loads the 3D script before the map and lets the terrain tiles through", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf("/assets/scripts/terrain.js") > -1);
  assert.ok(html.indexOf("/assets/scripts/terrain.js") < html.indexOf("/assets/scripts/dashboard.js"));
  const app = fs.readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /"connect-src": \[[^\]]*"https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/"/);
});

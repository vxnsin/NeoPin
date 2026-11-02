jest.mock("expo-location", () => ({ Accuracy: { Balanced: 3, High: 4, BestForNavigation: 6 } }));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { buildMapHtml } from "../lib/mapHtml";
import { getMap3d, loadSettings, setMap3d } from "../lib/settings";
import { BUILDING_COLORS, PITCH_3D, TERRAIN_CREDIT, TERRAIN_EXAGGERATION, TERRAIN_SCRIPT, TERRAIN_TILES } from "../lib/terrain";

type Layer = { id: string; type: string; source?: string; sourceLayer?: string; [key: string]: unknown };

// Just enough of a MapLibre map to see what the script does to the style and the camera.
function fakeMap(pitch = 0) {
  const layers: Layer[] = [
    { id: "background", type: "background" },
    { id: "water", type: "fill", source: "openmaptiles", sourceLayer: "water" },
    { id: "building", type: "fill", source: "openmaptiles", sourceLayer: "building" },
    { id: "highway_minor", type: "line", source: "openmaptiles" },
    { id: "place_city", type: "symbol", source: "openmaptiles" },
  ];
  const sources: Record<string, any> = { openmaptiles: { type: "vector" } };
  const visibility: Record<string, string> = {};
  const gestures = { rotate: false, touchRotate: false, touchPitch: true };
  const calls: { method: string; args: any[] }[] = [];
  let terrain: unknown = null;
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const map = {
    layers, sources, visibility, gestures, calls,
    pitch,
    getStyle: () => ({ layers }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    getSource: (id: string) => sources[id],
    addSource: (id: string, spec: unknown) => { sources[id] = spec; },
    removeSource: (id: string) => { delete sources[id]; },
    addLayer: (layer: any, before?: string) => {
      const at = before ? layers.findIndex((l) => l.id === before) : -1;
      const entry = { ...layer, sourceLayer: layer["source-layer"] };
      if (at < 0) layers.push(entry);
      else layers.splice(at, 0, entry);
    },
    removeLayer: (id: string) => { layers.splice(layers.findIndex((l) => l.id === id), 1); },
    setLayoutProperty: (id: string, _name: string, value: string) => { visibility[id] = value; },
    getTerrain: () => terrain,
    setTerrain: (spec: unknown) => { terrain = spec; },
    dragRotate: { enable: () => (gestures.rotate = true), disable: () => (gestures.rotate = false) },
    touchZoomRotate: { enableRotation: () => (gestures.touchRotate = true), disableRotation: () => (gestures.touchRotate = false) },
    touchPitch: { enable: () => (gestures.touchPitch = true), disable: () => (gestures.touchPitch = false) },
    getBearing: () => 20,
    getPitch: () => map.pitch,
    center: { lng: 11, lat: 47.5 },
    getCenter: () => map.center,
    getZoom: () => 12,
    on: (event: string, fn: (e: any) => void) => { (listeners[event] ||= []).push(fn); },
    off: (event: string, fn: (e: any) => void) => { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); },
    isSourceLoaded: () => true,
    fire: (event: string, e: any) => (listeners[event] || []).forEach((fn) => fn(e)),
    easeTo: (o: any) => calls.push({ method: "easeTo", args: [o] }),
    jumpTo: (o: any) => calls.push({ method: "jumpTo", args: [o] }),
    flyTo: (o: any) => calls.push({ method: "flyTo", args: [o] }),
    fitBounds: (b: any, o: any) => calls.push({ method: "fitBounds", args: [b, o] }),
    cameraForBounds: () => ({ center: [11, 47.5], zoom: 12, bearing: 20 }),
    terrain: null,
    // A flat, square "projection": 100 px per degree around the centre, smaller when zoomed out.
    transform: {
      clone() {
        const t = {
          width: 400, height: 800, padding: { top: 0, bottom: 0, left: 0, right: 0 },
          zoom: 0, center: { lng: 0, lat: 0 }, centerPoint: { x: 200, y: 400 },
          setPitch() {}, setZoom(z: number) { t.zoom = z; }, setCenter(c: any) { t.center = c; },
          locationToScreenPoint(p: any) {
            const k = 100 * Math.pow(2, t.zoom - 12);
            return { x: 200 + (p.lng - t.center.lng) * k, y: 400 - (p.lat - t.center.lat) * k };
          },
          screenPointToLocation(p: any) {
            const k = 100 * Math.pow(2, t.zoom - 12);
            return { lng: t.center.lng + (p.x - 200) / k, lat: t.center.lat - (p.y - 400) / k };
          },
        };
        return t;
      },
    },
  };
  return map;
}

const maplibregl = {
  LngLat: { convert: (p: any) => (Array.isArray(p) ? { lng: p[0], lat: p[1] } : p) },
  LngLatBounds: class {
    points: number[][] = [];
    extend(p: number[]) { this.points.push(p); return this; }
  },
};

type Script = {
  applyTerrain: (map: any, on: boolean, dark: boolean) => void;
  tiltCamera: (map: any, on: boolean) => void;
  fitPoints: (map: any, points: number[][], padding: object, maxZoom: number, duration: number) => void;
  watchPitch: (map: any) => void;
  followTerrain: (map: any, items: () => any[]) => void;
};
// The functions as the WebView sees them: cut out of the generated page and evaluated.
function script(): Script {
  expect(buildMapHtml(false, 0)).toContain(TERRAIN_SCRIPT);
  return new Function("maplibregl", "requestAnimationFrame", `${TERRAIN_SCRIPT}; return { applyTerrain, tiltCamera, fitPoints, watchPitch, followTerrain };`)(
    maplibregl,
    (fn: () => void) => fn()
  );
}

test("the terrain comes from the free Terrarium tiles, credited, and only up to z12", () => {
  const map = fakeMap();
  script().applyTerrain(map, true, false);
  expect(map.sources["terrain-dem"]).toEqual({ type: "raster-dem", tiles: [TERRAIN_TILES], encoding: "terrarium", tileSize: 256, maxzoom: 12, attribution: TERRAIN_CREDIT });
  // Ground and shading share the one source, each tile is decoded once.
  expect(map.sources["hillshade-dem"]).toBeUndefined();
  expect(map.layers.find((l) => l.id === "hillshade")).toMatchObject({ source: "terrain-dem" });
  expect(TERRAIN_TILES).toBe("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png");
  expect(map.getTerrain()).toEqual({ source: "terrain-dem", exaggeration: TERRAIN_EXAGGERATION });
  expect(TERRAIN_EXAGGERATION).toBeCloseTo(1.3);
  // The page says where the mountains come from while 3D is on.
  expect(buildMapHtml(false, 0)).toContain(`<span id="terrain-credit" hidden> · ${TERRAIN_CREDIT}</span>`);
});

test("3D shades the hills under the buildings and pulls the buildings up under the labels", () => {
  const map = fakeMap();
  script().applyTerrain(map, true, false);
  const ids = map.layers.map((l) => l.id);
  expect(ids).toEqual(["background", "water", "hillshade", "building", "highway_minor", "building-3d", "place_city"]);
  const extruded = map.layers.find((l) => l.id === "building-3d") as any;
  expect(extruded).toMatchObject({ type: "fill-extrusion", source: "openmaptiles", sourceLayer: "building", minzoom: 14 });
  expect(JSON.stringify(extruded.paint["fill-extrusion-height"])).toContain("render_height");
  expect(JSON.stringify(extruded.paint["fill-extrusion-base"])).toContain("render_min_height");
  expect(extruded.paint["fill-extrusion-color"]).toBe(BUILDING_COLORS.light);
  expect(map.visibility.building).toBe("none");
  expect(map.gestures).toEqual({ rotate: true, touchRotate: true, touchPitch: true });
});

test("dark buildings and shading take the dark colours", () => {
  const map = fakeMap();
  script().applyTerrain(map, true, true);
  const extruded = map.layers.find((l) => l.id === "building-3d") as any;
  expect(extruded.paint["fill-extrusion-color"]).toBe(BUILDING_COLORS.dark);
  const shade = map.layers.find((l) => l.id === "hillshade") as any;
  expect(shade.paint["hillshade-shadow-color"]).toBe("#05070b");
});

test("switching on twice adds nothing twice, off leaves the flat map as it was", () => {
  const map = fakeMap();
  const before = map.layers.map((l) => l.id);
  const { applyTerrain } = script();
  applyTerrain(map, true, false);
  applyTerrain(map, true, false);
  expect(map.layers.filter((l) => l.id === "building-3d")).toHaveLength(1);
  applyTerrain(map, false, false);
  expect(map.layers.map((l) => l.id)).toEqual(before);
  expect(Object.keys(map.sources)).toEqual(["openmaptiles"]);
  expect(map.getTerrain()).toBeNull();
  expect(map.visibility.building).toBe("visible");
  // North stays up when flat; the two-finger tilt the flat map always had stays.
  expect(map.gestures).toEqual({ rotate: false, touchRotate: false, touchPitch: true });
});

test("the switch tilts to 55 degrees and back to flat, facing north", () => {
  const map = fakeMap();
  const { tiltCamera } = script();
  tiltCamera(map, true);
  expect(map.calls[0].args[0]).toMatchObject({ pitch: PITCH_3D, bearing: 20 });
  tiltCamera(map, false);
  expect(map.calls[1].args[0]).toMatchObject({ pitch: 0, bearing: 0 });
  expect(PITCH_3D).toBe(55);
  // Opening the map in 3D jumps there, a later jump to a position cannot cut the tilt short.
  tiltCamera(map, true, true);
  expect(map.calls[2]).toEqual({ method: "jumpTo", args: [{ pitch: PITCH_3D, bearing: 20 }] });
});

test("flat, a trip is fitted with fitBounds as before", () => {
  const map = fakeMap();
  script().fitPoints(map, [[11, 47.5], [11.1, 47.6]], { top: 10, bottom: 10, left: 10, right: 10 }, 16.5, 600);
  expect(map.calls).toHaveLength(1);
  expect(map.calls[0].method).toBe("fitBounds");
  expect(map.calls[0].args[1]).toEqual({ padding: { top: 10, bottom: 10, left: 10, right: 10 }, maxZoom: 16.5, duration: 600 });
});

test("tilted, a trip is fitted at the 3D pitch even while the map is still tilting", () => {
  const map = fakeMap(3);
  const s = script();
  s.tiltCamera(map, true);
  map.calls.length = 0;
  const points = [[11, 47.5], [11.02, 47.52], [11.04, 47.5]];
  s.fitPoints(map, points, { top: 100, bottom: 300, left: 40, right: 40 }, 16.5, 600);
  expect(map.calls).toHaveLength(1);
  const fly = map.calls[0];
  expect(fly.method).toBe("flyTo");
  expect(fly.args[0]).toMatchObject({ pitch: PITCH_3D, bearing: 20, duration: 600 });
  // Every point lands inside the padding at the chosen camera.
  const tr = map.transform.clone();
  tr.setZoom(fly.args[0].zoom);
  tr.setCenter(maplibregl.LngLat.convert(fly.args[0].center));
  for (const p of points) {
    const at = tr.locationToScreenPoint(maplibregl.LngLat.convert(p));
    expect(at.x).toBeGreaterThanOrEqual(39);
    expect(at.x).toBeLessThanOrEqual(361);
    expect(at.y).toBeGreaterThanOrEqual(99);
    expect(at.y).toBeLessThanOrEqual(501);
  }
  // A finger that tilts the map changes the pitch later fits keep.
  s.watchPitch(map);
  map.pitch = 40;
  map.fire("pitchend", { originalEvent: {} });
  s.fitPoints(map, points, { top: 100, bottom: 300, left: 40, right: 40 }, 16.5, 600);
  expect(map.calls[1].args[0].pitch).toBe(40);
});

test("a tilted fit before the mountains are in measures again once they are, unless a finger moved", () => {
  const s = script();
  const points = [[11, 47.5], [11.04, 47.52]];
  const pad = { top: 100, bottom: 300, left: 40, right: 40 };
  for (const moved of [false, true]) {
    const map = fakeMap();
    s.tiltCamera(map, true);
    s.applyTerrain(map, true, false);
    map.calls.length = 0;
    s.fitPoints(map, points, pad, 16.5, 600);
    expect(map.calls).toHaveLength(1);
    if (moved) map.fire("movestart", { originalEvent: {} });
    (map as any).terrain = {};
    map.fire("idle", {});
    expect(map.calls).toHaveLength(moved ? 1 : 2);
    map.fire("idle", {});
    expect(map.calls).toHaveLength(moved ? 1 : 2);
  }
});

// A marker as far as the script touches it.
function fakeMarker() {
  const log: string[] = [];
  return {
    log,
    setSubpixelPositioning: (on: boolean) => log.push("subpixel " + on),
    setOpacity: (...args: string[]) => log.push("opacity " + args.join(",")),
    getLngLat: () => ({ lng: 11, lat: 47.5 }),
    setLngLat: () => log.push("place"),
  };
}

test("in 3D the markers are placed again after frames that moved something, off it is left to MapLibre", () => {
  const map = fakeMap();
  let terrain: unknown = null;
  map.getTerrain = () => terrain;
  const pin = fakeMarker();
  const items: any[] = [pin, null];
  script().followTerrain(map, () => items);
  map.fire("render", {});
  expect(pin.log).toEqual([]);
  terrain = { source: "terrain-dem" };
  map.fire("render", {});
  map.fire("render", {});
  // Set up once: no pixel snapping, fully drawn behind hills; then placed again when the camera moved.
  expect(pin.log).toEqual(["subpixel true", "opacity 1,1", "place", "place"]);
  // A frame where nothing moved costs nothing: that was what made slower phones lag.
  map.fire("render", {});
  map.fire("render", {});
  expect(pin.log).toHaveLength(4);
  // The camera moves, the ground arrives, a marker comes: placed again each time.
  map.center = { lng: 11.001, lat: 47.5 };
  map.fire("render", {});
  map.fire("sourcedata", { sourceId: "terrain-dem" });
  map.fire("render", {});
  const other = fakeMarker();
  items.push(other);
  map.fire("render", {});
  expect(pin.log.slice(4)).toEqual(["place", "place", "place"]);
  expect(other.log).toEqual(["subpixel true", "opacity 1,1", "place"]);
  terrain = null;
  map.fire("render", {});
  map.fire("render", {});
  expect(pin.log.slice(7)).toEqual(["subpixel false", "opacity ", "place"]);
});

test("every marker on the map page stands upright on its point", () => {
  const html = buildMapHtml(false, 0);
  const markers = html.match(/new maplibregl\.Marker\(\{[^}]*\}/g) ?? [];
  expect(markers.length).toBeGreaterThanOrEqual(5);
  for (const m of markers) expect(m).toContain('pitchAlignment: "viewport", rotationAlignment: "viewport"');
  // The avatar pins hang from their tip.
  expect(html).toContain('anchor: "bottom", offset: [0, -8]');
});

test("the page switches 3D by message and starts flat", () => {
  const html = buildMapHtml(true, 0);
  expect(html).toContain('data.type === "map3d"');
  expect(html).toContain("var threeD = false;");
  // A theme change drops the style, the 3D layers come back with the new one.
  expect(html).toContain('map.on("style.load", function () { if (threeD) set3d(true, false); });');
});

test("the 3D switch is off by default and remembered per phone", async () => {
  expect(getMap3d()).toBe(false);
  await AsyncStorage.setItem("settings", JSON.stringify({ reporting: "precise", map3d: true }));
  await loadSettings();
  expect(getMap3d()).toBe(true);
  await setMap3d(false);
  expect(JSON.parse((await AsyncStorage.getItem("settings")) as string)).toEqual({ reporting: "precise", map3d: false });
});

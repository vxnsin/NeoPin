// The 3D map: mountains from the free AWS Open Data terrain tiles (Terrarium PNGs, no key),
// hillshading and the OpenFreeMap buildings pulled up to their height. Off, the map is flat as before.
// The same as the app's map (lib/terrain.ts there); dashboard.js wires it to the map.
const TERRAIN = {
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  credit: "Terrain: Mapzen, AWS Open Data",
  exaggeration: 1.3,
  pitch: 55,
  // z12 is about 38 m per pixel in the Alps, enough for mountains; MapLibre overzooms from there,
  // so a city at z16 does not pull in finer tiles.
  maxzoom: 12,
  // A little lighter than the land in light, a little lighter than the flat buildings in dark.
  buildings: { light: "#d9dde5", dark: "#2c3649" },
};
// Per browser, like the theme.
const MAP3D_KEY = "neopin-map3d";

function stored3d() {
  try {
    return localStorage.getItem(MAP3D_KEY) === "on";
  } catch {
    return false;
  }
}

function store3d(on) {
  try {
    localStorage.setItem(MAP3D_KEY, on ? "on" : "off");
  } catch {
    // Private windows may refuse storage, the switch still works for this page.
  }
}

const demSource = () => ({
  type: "raster-dem",
  tiles: TERRAIN.tiles,
  encoding: "terrarium",
  tileSize: 256,
  maxzoom: TERRAIN.maxzoom,
  attribution: TERRAIN.credit,
});

// Shading and buildings go under the first label, so names stay on top.
function firstLabel(map) {
  return (map.getStyle()?.layers ?? []).find((layer) => layer.type === "symbol")?.id;
}

// Turning only in 3D; flat keeps the gestures it always had (north stays up).
function rotateGestures(map, on) {
  if (on) {
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.keyboard.enableRotation();
    map.touchPitch.enable();
  } else {
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
  }
}

// Adds or removes everything 3D on the current style. A style change (theme) drops it all,
// so style.load calls this again; the DEM only loads while 3D is on.
function applyTerrain(map, on, dark) {
  if (!on) {
    if (map.getTerrain()) map.setTerrain(null);
    for (const id of ["building-3d", "hillshade"]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ["terrain-dem", "hillshade-dem"]) if (map.getSource(id)) map.removeSource(id);
    if (map.getLayer("building")) map.setLayoutProperty("building", "visibility", "visible");
    rotateGestures(map, false);
    return;
  }
  if (!map.getSource("terrain-dem")) map.addSource("terrain-dem", demSource());
  // MapLibre draws the shading in lower quality when it shares the source with the terrain;
  // the second source fetches the same URLs, which the browser cache answers.
  if (!map.getSource("hillshade-dem")) map.addSource("hillshade-dem", demSource());
  const label = firstLabel(map);
  if (!map.getLayer("hillshade")) {
    map.addLayer(
      {
        id: "hillshade",
        type: "hillshade",
        source: "hillshade-dem",
        paint: dark
          ? { "hillshade-shadow-color": "#05070b", "hillshade-highlight-color": "#3a465e", "hillshade-accent-color": "#0d1119", "hillshade-exaggeration": 0.45 }
          : { "hillshade-shadow-color": "#5b6577", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#8a93a5", "hillshade-exaggeration": 0.3 },
      },
      map.getLayer("building") ? "building" : label
    );
  }
  const flat = map.getLayer("building");
  if (flat && !map.getLayer("building-3d")) {
    map.addLayer(
      {
        id: "building-3d",
        type: "fill-extrusion",
        source: flat.source,
        "source-layer": flat.sourceLayer || "building",
        minzoom: 14,
        filter: ["!=", ["get", "hide_3d"], true],
        paint: {
          "fill-extrusion-color": dark ? TERRAIN.buildings.dark : TERRAIN.buildings.light,
          // They grow out of the ground between z14 and z15 instead of popping up.
          "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, ["to-number", ["get", "render_height"], 0]],
          "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, ["to-number", ["get", "render_min_height"], 0]],
          "fill-extrusion-opacity": 0.85,
        },
      },
      label
    );
    map.setLayoutProperty("building", "visibility", "none");
  }
  map.setTerrain({ source: "terrain-dem", exaggeration: TERRAIN.exaggeration });
  rotateGestures(map, true);
}

// The tilt a fit keeps: the switch sets it, a drag or the keyboard changes it. Not map.getPitch(),
// a fit that comes in while the map is still tilting would stop it halfway.
let terrainPitch = 0;

function watchPitch(map) {
  map.on("pitchend", (event) => {
    if (event.originalEvent) terrainPitch = map.getPitch();
  });
}

// The switch itself: tilt in, or back to the flat map facing north. Instant when the page opens
// in 3D, the first fit would stop the tilt halfway.
function tiltCamera(map, on, instant = false) {
  terrainPitch = on ? TERRAIN.pitch : 0;
  const view = { pitch: terrainPitch, bearing: on ? map.getBearing() : 0 };
  if (instant) map.jumpTo(view);
  else map.easeTo({ ...view, duration: 700 });
}

// Every marker stands upright on its point: pitch and rotation follow the screen, not the map.
const UPRIGHT = { pitchAlignment: "viewport", rotationAlignment: "viewport" };

// MapLibre places the markers when the camera moves, but lifts the camera onto the ground under
// the map centre only later, while drawing the frame: over hills every pin trails a frame behind
// and wobbles, and a DEM tile that arrives later leaves it at the old height. So in 3D every
// marker and popup is placed again after each frame, without pixel snapping (snapping every
// frame stutters), and a pin behind a hill stays fully drawn instead of blinking.
let terrainSettled = new WeakSet();

function followTerrain(map, items) {
  let was = false;
  map.on("render", () => {
    const on = !!map.getTerrain();
    if (!on && !was) return;
    for (const item of items()) {
      if (!item) continue;
      if (on && !terrainSettled.has(item)) {
        terrainSettled.add(item);
        item.setSubpixelPositioning(true);
        item.setOpacity?.("1", "1");
      } else if (!on) {
        item.setSubpixelPositioning(false);
        item.setOpacity?.();
      }
      item.setLngLat(item.getLngLat());
    }
    if (!on) terrainSettled = new WeakSet();
    was = on;
  });
}

// cameraForBounds measures on the flat map; tilted, the near half grows and the far half shrinks.
// So the camera is tried on a copy of the transform with the fit's padding, recentred and zoomed
// until every point sits inside it.
function tiltedCamera(map, points, padding, camera, maxZoom) {
  const tr = map.transform.clone();
  tr.setPadding(padding);
  tr.setPitch(terrainPitch);
  const box = { left: padding.left, right: tr.width - padding.right, top: padding.top, bottom: tr.height - padding.bottom };
  const step = Math.max(1, Math.ceil(points.length / 200));
  const sample = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => maplibregl.LngLat.convert(p));
  let center = maplibregl.LngLat.convert(camera.center);
  let zoom = Math.min(maxZoom, camera.zoom);
  let best = null;
  for (let i = 0; i < 8; i++) {
    tr.setZoom(zoom);
    tr.setCenter(center);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of sample) {
      const s = tr.locationToScreenPoint(p, map.terrain);
      minX = Math.min(minX, s.x);
      maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y);
      maxY = Math.max(maxY, s.y);
    }
    const fits = minX >= box.left - 1 && maxX <= box.right + 1 && minY >= box.top - 1 && maxY <= box.bottom + 1;
    const scale = Math.min((box.right - box.left) / Math.max(1, maxX - minX), (box.bottom - box.top) / Math.max(1, maxY - minY));
    if (fits) best = { center, zoom };
    if (fits && (scale < 1.15 || zoom >= maxZoom)) break;
    center = shiftCenter(tr, center, (minX + maxX - box.left - box.right) / 2, (minY + maxY - box.top - box.bottom) / 2);
    zoom = Math.min(maxZoom, zoom + Math.log2(scale) * 0.9);
  }
  return best ?? { center, zoom: zoom - 0.5 };
}

// The point dx, dy px from the middle of the view. Before the map has drawn its first frame the copy
// cannot unproject yet, then the flat scale at the centre stands in.
function shiftCenter(tr, center, dx, dy) {
  const mid = tr.centerPoint;
  try {
    const next = tr.screenPointToLocation(new mid.constructor(mid.x + dx, mid.y + dy));
    if (Number.isFinite(next.lng) && Number.isFinite(next.lat)) return next;
  } catch {
    // falls through
  }
  const world = 512 * 2 ** tr.zoom;
  const turn = (tr.bearing * Math.PI) / 180;
  const at = maplibregl.MercatorCoordinate.fromLngLat(center);
  const x = dx * Math.cos(turn) - dy * Math.sin(turn);
  const y = dx * Math.sin(turn) + dy * Math.cos(turn);
  return new maplibregl.MercatorCoordinate(at.x + x / world, at.y + y / world).toLngLat();
}

// Before the mountains are loaded a tilted fit measures them flat and the peaks rise out of the
// padding afterwards. So it measures once more when they are in, unless someone moved the map.
let pendingRefit = null;

function terrainReady(map) {
  return !!map.terrain && !!map.getSource("terrain-dem") && map.isSourceLoaded("terrain-dem");
}

function refitWhenTerrain(map, refit) {
  const waiting = pendingRefit !== null;
  pendingRefit = refit;
  if (waiting) return;
  let moved = false;
  const onMove = (event) => {
    if (event.originalEvent) moved = true;
  };
  const check = () => {
    if (map.getTerrain() && !terrainReady(map)) return;
    map.off("idle", check);
    map.off("movestart", onMove);
    const fn = pendingRefit;
    pendingRefit = null;
    if (!moved && map.getTerrain()) fn();
  };
  map.on("movestart", onMove);
  map.on("idle", check);
}

// The 3D switch next to the zoom buttons.
class TerrainControl {
  constructor(onToggle) {
    this.onToggle = onToggle;
  }
  onAdd() {
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "terrain-button";
    this.button.textContent = "3D";
    this.button.title = "3D map: mountains and buildings";
    this.button.addEventListener("click", () => this.onToggle());
    this.container.append(this.button);
    this.setOn(false);
    return this.container;
  }
  setOn(on) {
    this.button?.setAttribute("aria-pressed", String(on));
    this.button?.setAttribute("aria-label", on ? "Flat map" : "3D map");
  }
  onRemove() {
    this.container.remove();
  }
}

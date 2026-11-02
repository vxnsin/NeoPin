// The 3D map: mountains from the free AWS Open Data terrain tiles (Terrarium PNGs, no key),
// hillshading and the OpenFreeMap buildings pulled up to their height. Off, the map is flat as before.
export const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const TERRAIN_CREDIT = "Terrain: Mapzen, AWS Open Data";
export const TERRAIN_EXAGGERATION = 1.3;
export const PITCH_3D = 55;
// z12 is about 38 m per pixel in the Alps, enough for mountains; MapLibre overzooms from there,
// so a city at z16 does not pull in finer tiles.
export const TERRAIN_MAXZOOM = 12;
// From the map's own colours: a little lighter than the land in light, a little lighter than
// the flat buildings (#262f40) in dark.
export const BUILDING_COLORS = { light: "#d9dde5", dark: "#2c3649" };

// Runs inside the map page (WebView and the jest tests), so plain ES5 that only uses the map it is given.
export const TERRAIN_SCRIPT = `var TERRAIN = ${JSON.stringify({
  tiles: [TERRAIN_TILES],
  credit: TERRAIN_CREDIT,
  exaggeration: TERRAIN_EXAGGERATION,
  pitch: PITCH_3D,
  maxzoom: TERRAIN_MAXZOOM,
  buildings: BUILDING_COLORS,
})};
    function demSource() {
      return { type: "raster-dem", tiles: TERRAIN.tiles, encoding: "terrarium", tileSize: 256, maxzoom: TERRAIN.maxzoom, attribution: TERRAIN.credit };
    }
    // Shading and buildings go under the first label, so names stay on top.
    function firstLabel(map) {
      var layers = (map.getStyle() || {}).layers || [];
      for (var i = 0; i < layers.length; i++) if (layers[i].type === "symbol") return layers[i].id;
      return undefined;
    }
    // Turning only in 3D; flat keeps the gestures it always had (north stays up).
    function rotateGestures(map, on) {
      if (on) { map.dragRotate.enable(); map.touchZoomRotate.enableRotation(); map.touchPitch.enable(); }
      else { map.dragRotate.disable(); map.touchZoomRotate.disableRotation(); }
    }
    // Adds or removes everything 3D on the current style. A style change (theme) drops it all,
    // so style.load calls this again; the DEM only loads while 3D is on.
    function applyTerrain(map, on, dark) {
      if (!on) {
        if (map.getTerrain && map.getTerrain()) map.setTerrain(null);
        ["building-3d", "hillshade"].forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
        ["terrain-dem", "hillshade-dem"].forEach(function (id) { if (map.getSource(id)) map.removeSource(id); });
        if (map.getLayer("building")) map.setLayoutProperty("building", "visibility", "visible");
        rotateGestures(map, false);
        return;
      }
      if (!map.getSource("terrain-dem")) map.addSource("terrain-dem", demSource());
      // MapLibre draws the shading in lower quality when it shares the source with the terrain;
      // the second source fetches the same URLs, which the browser cache answers.
      if (!map.getSource("hillshade-dem")) map.addSource("hillshade-dem", demSource());
      var label = firstLabel(map);
      if (!map.getLayer("hillshade")) {
        map.addLayer({ id: "hillshade", type: "hillshade", source: "hillshade-dem", paint: dark
          ? { "hillshade-shadow-color": "#05070b", "hillshade-highlight-color": "#3a465e", "hillshade-accent-color": "#0d1119", "hillshade-exaggeration": 0.45 }
          : { "hillshade-shadow-color": "#5b6577", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#8a93a5", "hillshade-exaggeration": 0.3 } },
          map.getLayer("building") ? "building" : label);
      }
      var flat = map.getLayer("building");
      if (flat && !map.getLayer("building-3d")) {
        map.addLayer({ id: "building-3d", type: "fill-extrusion", source: flat.source, "source-layer": flat.sourceLayer || "building", minzoom: 14,
          filter: ["!=", ["get", "hide_3d"], true],
          paint: {
            "fill-extrusion-color": dark ? TERRAIN.buildings.dark : TERRAIN.buildings.light,
            // They grow out of the ground between z14 and z15 instead of popping up.
            "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, ["to-number", ["get", "render_height"], 0]],
            "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, ["to-number", ["get", "render_min_height"], 0]],
            "fill-extrusion-opacity": 0.85
          } }, label);
        map.setLayoutProperty("building", "visibility", "none");
      }
      map.setTerrain({ source: "terrain-dem", exaggeration: TERRAIN.exaggeration });
      rotateGestures(map, true);
    }
    // The tilt a fit keeps: the switch sets it, a finger changes it. Not map.getPitch(), a fit that
    // comes in while the map is still tilting would stop it halfway.
    var terrainPitch = 0;
    function watchPitch(map) {
      map.on("pitchend", function (e) { if (e.originalEvent) terrainPitch = map.getPitch(); });
    }
    // MapLibre places the markers when the camera moves, but lifts the camera onto the ground under
    // the map centre only later, while drawing the frame: over hills every pin trails a frame behind
    // and wobbles, and a DEM tile that arrives later leaves it at the old height. So in 3D every
    // marker and popup is placed again after each frame, without pixel snapping (snapping every
    // frame stutters), and a pin behind a hill stays fully drawn instead of blinking.
    var terrainSettled = new WeakSet();
    function followTerrain(map, items) {
      var was = false;
      map.on("render", function () {
        var on = !!map.getTerrain();
        if (!on && !was) return;
        items().forEach(function (item) {
          if (!item) return;
          if (on && !terrainSettled.has(item)) {
            terrainSettled.add(item);
            item.setSubpixelPositioning(true);
            if (item.setOpacity) item.setOpacity("1", "1");
          } else if (!on) {
            item.setSubpixelPositioning(false);
            if (item.setOpacity) item.setOpacity();
          }
          item.setLngLat(item.getLngLat());
        });
        if (!on) terrainSettled = new WeakSet();
        was = on;
      });
    }
    // The switch itself: tilt in, or back to the flat map facing north. Instant when the map opens
    // in 3D, the first jump to a position would stop the tilt halfway.
    function tiltCamera(map, on, instant) {
      terrainPitch = on ? TERRAIN.pitch : 0;
      var view = { pitch: on ? TERRAIN.pitch : 0, bearing: on ? map.getBearing() : 0 };
      if (instant) map.jumpTo(view);
      else map.easeTo(Object.assign(view, { duration: 700 }));
    }
    // fitBounds measures on the flat map; tilted, the near half grows and the far half shrinks.
    // So the camera is tried on a copy of the transform, recentred and zoomed until every point
    // sits inside the padding.
    function tiltedCamera(map, points, padding, cam, maxZoom) {
      var tr = map.transform.clone();
      tr.setPitch(terrainPitch);
      var edge = tr.padding || { top: 0, bottom: 0, left: 0, right: 0 };
      var box = { left: edge.left + padding.left, right: tr.width - edge.right - padding.right, top: edge.top + padding.top, bottom: tr.height - edge.bottom - padding.bottom };
      var step = Math.max(1, Math.ceil(points.length / 200));
      var sample = points.filter(function (p, i) { return i % step === 0 || i === points.length - 1; });
      var center = maplibregl.LngLat.convert(cam.center), zoom = Math.min(maxZoom, cam.zoom), best = null;
      for (var i = 0; i < 8; i++) {
        tr.setZoom(zoom);
        tr.setCenter(center);
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        sample.forEach(function (p) {
          var s = tr.locationToScreenPoint(maplibregl.LngLat.convert(p), map.terrain);
          minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
        });
        var fits = minX >= box.left - 1 && maxX <= box.right + 1 && minY >= box.top - 1 && maxY <= box.bottom + 1;
        var scale = Math.min((box.right - box.left) / Math.max(1, maxX - minX), (box.bottom - box.top) / Math.max(1, maxY - minY));
        if (fits) best = { center: center, zoom: zoom };
        if (fits && (scale < 1.15 || zoom >= maxZoom)) break;
        center = shiftCenter(tr, center, (minX + maxX - box.left - box.right) / 2, (minY + maxY - box.top - box.bottom) / 2);
        zoom = Math.min(maxZoom, zoom + Math.log2(scale) * 0.9);
      }
      return best || { center: center, zoom: zoom - 0.5 };
    }
    // The point dx, dy px from the middle of the view. Before the map has drawn its first frame the
    // copy cannot unproject yet, then the flat scale at the centre stands in.
    function shiftCenter(tr, center, dx, dy) {
      var mid = tr.centerPoint;
      try {
        var next = tr.screenPointToLocation(new mid.constructor(mid.x + dx, mid.y + dy));
        if (isFinite(next.lng) && isFinite(next.lat)) return next;
      } catch (e) { /* falls through */ }
      var world = 512 * Math.pow(2, tr.zoom);
      var turn = tr.bearing * Math.PI / 180;
      var at = maplibregl.MercatorCoordinate.fromLngLat(center);
      var x = dx * Math.cos(turn) - dy * Math.sin(turn);
      var y = dx * Math.sin(turn) + dy * Math.cos(turn);
      return new maplibregl.MercatorCoordinate(at.x + x / world, at.y + y / world).toLngLat();
    }
    // Before the mountains are loaded a tilted fit measures them flat and the peaks rise out of the
    // padding afterwards. So it measures once more when they are in, unless a finger moved the map.
    var pendingRefit = null;
    function terrainReady(map) {
      return !!map.terrain && !!map.getSource("terrain-dem") && map.isSourceLoaded("terrain-dem");
    }
    function refitWhenTerrain(map, refit) {
      var waiting = pendingRefit !== null;
      pendingRefit = refit;
      if (waiting) return;
      var moved = false;
      var onMove = function (e) { if (e.originalEvent) moved = true; };
      var check = function () {
        if (map.getTerrain() && !terrainReady(map)) return;
        map.off("idle", check);
        map.off("movestart", onMove);
        var fn = pendingRefit;
        pendingRefit = null;
        if (!moved && map.getTerrain()) fn();
      };
      map.on("movestart", onMove);
      map.on("idle", check);
    }
    function fitPoints(map, points, padding, maxZoom, duration) {
      var bounds = new maplibregl.LngLatBounds();
      points.forEach(function (p) { bounds.extend(p); });
      if (terrainPitch < 1) { map.fitBounds(bounds, { padding: padding, maxZoom: maxZoom, duration: duration }); return; }
      var cam = map.cameraForBounds(bounds, { padding: padding, maxZoom: maxZoom, bearing: map.getBearing() });
      if (!cam) return;
      try { cam = tiltedCamera(map, points, padding, cam, maxZoom); } catch (e) { cam.zoom -= 1; }
      map.flyTo({ center: cam.center, zoom: cam.zoom, bearing: map.getBearing(), pitch: terrainPitch, duration: duration });
      if (!terrainReady(map)) refitWhenTerrain(map, function () { fitPoints(map, points, padding, maxZoom, duration); });
    }`;

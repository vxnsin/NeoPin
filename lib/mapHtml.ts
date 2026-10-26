import { STALE_AFTER_MS, STATE_COLORS } from "@/lib/devices";

// OpenFreeMap serves vector tiles without an API key, the same styles as the dashboard.
export const MAP_STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

const MAPLIBRE = "https://unpkg.com/maplibre-gl@5.6.0/dist";
// From this zoom on every pin shows its name without being touched, like on the dashboard.
export const LABEL_ZOOM = 14;
// The device bar of the map screen covers this much of the bottom, plus the safe area.
const BAR_HEIGHT = 96;

// The map page inside the WebView. React Native talks to it with postMessage:
// { type: "devices", devices }, { type: "self", latitude, longitude, center },
// { type: "focus", key } and { type: "theme", dark }. The timeline adds
// { type: "route", segments, bottom } to draw a day (trip lines and numbered stops),
// { type: "routeFocus", index } to zoom to one segment (null for the whole day)
// and { type: "routeClear" } to go back to the live pins. The map answers a tap on
// a stop or a line with { type: "segment", index }.
export function buildMapHtml(dark: boolean, bottomInset = 0): string {
  const bottom = BAR_HEIGHT + bottomInset;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="stylesheet" href="${MAPLIBRE}/maplibre-gl.css" integrity="sha384-Nq6PQ+9vJPvw7U/VfDELyrWoGQMsy0gi6QShhaSrGzkpF5KkM40csg2leky+YMTd" crossorigin="anonymous">
  <script src="${MAPLIBRE}/maplibre-gl.js" integrity="sha384-GfxBM9x46BaAFxtCq39Fxir8fNZ4VDnwgfi6Kzi5/F1tAFsm0amuuV8kd+Pxzuf/" crossorigin="anonymous"></script>
  <style>
    :root { --surface: #ffffff; --text: #0f172a; --muted: #5b6577; --bg: #eceef2; --shadow: 0 8px 20px -8px rgba(15,23,42,.35), 0 1px 3px rgba(15,23,42,.1); }
    :root.dark { --surface: #161a22; --text: #f1f4f9; --muted: #98a2b3; --bg: #0a0c10; --shadow: 0 8px 20px -8px rgba(0,0,0,.8), 0 1px 3px rgba(0,0,0,.4); }
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body, #map { height: 100%; width: 100%; background: var(--bg); font-family: system-ui, -apple-system, Roboto, sans-serif; }
    .maplibregl-ctrl-attrib { font-size: 10px; background: color-mix(in srgb, var(--surface) 80%, transparent) !important; color: var(--muted); }
    .maplibregl-ctrl-attrib a { color: inherit; }
    .dark .maplibregl-ctrl-attrib-button { filter: invert(1); }
    .maplibregl-ctrl-bottom-left, .maplibregl-ctrl-bottom-right { margin-bottom: ${bottom}px; }

    .pin { display: block; border: 0; background: none; padding: 0; }
    .pin.selected { z-index: 5; }
    .pin-body { position: relative; display: flex; flex-direction: column; align-items: center; transform-origin: 50% 100%; transition: transform .2s; }
    .pin.selected .pin-body { transform: scale(1.12); }
    .bubble { position: relative; padding: 5px; border-radius: 50%; background: var(--surface); box-shadow: var(--shadow); }
    .bubble::after { content: ""; position: absolute; left: 50%; bottom: -5px; z-index: -1; width: 13px; height: 13px; border-radius: 3px; background: var(--surface); transform: translateX(-50%) rotate(45deg); }
    .avatar { position: relative; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; color: #fff; font: 700 15px system-ui, sans-serif;
      box-shadow: 0 0 0 2px var(--surface), 0 0 0 4.5px var(--ring); }
    .avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
    .online { --ring: ${STATE_COLORS.online}; }
    .stale { --ring: ${STATE_COLORS.stale}; }
    .offline { --ring: ${STATE_COLORS.offline}; }
    .offline.avatar { background: ${STATE_COLORS.offline} !important; }
    .offline.avatar > * { filter: grayscale(1); opacity: .7; }
    .pin .online.avatar::after { content: ""; position: absolute; inset: -4.5px; border-radius: 50%; border: 2px solid ${STATE_COLORS.online}; animation: ripple 2.4s ease-out infinite; }
    .label { position: absolute; top: calc(100% + 9px); max-width: 140px; overflow: hidden; padding: 2px 8px; border-radius: 999px; background: var(--surface); color: var(--text);
      box-shadow: var(--shadow); font-size: 11.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap;
      opacity: 0; transform: translateY(-4px); transition: opacity .2s, transform .2s; pointer-events: none; }
    .show-labels .label, .pin.selected .label { opacity: 1; transform: none; }
    .offline .label { color: var(--muted); }
    .self { width: 20px; height: 20px; border-radius: 50%; background: #d3171e; border: 3px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.15), 0 2px 8px rgba(0,0,0,.35); }
    .self::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: #d3171e; opacity: .35; animation: halo 2s ease-out infinite; z-index: -1; }

    .maplibregl-popup-content { padding: 12px 14px; border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); font: 13px/1.4 system-ui, sans-serif; }
    .maplibregl-popup-anchor-bottom .maplibregl-popup-tip { border-top-color: var(--surface); }
    .popup b { display: block; max-width: 200px; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
    .popup span { color: var(--muted); font-size: 12px; }

    .route-mode .pin { display: none; }
    .stop { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 2.5px solid #fff; border-radius: 50%; background: #d3171e; color: #fff;
      box-shadow: var(--shadow); font: 700 13px system-ui, sans-serif; transition: transform .15s; }
    .stop.active { z-index: 6; background: #0f172a; transform: scale(1.25); }
    .dark .stop.active { background: #fff; color: #0f172a; border-color: #0f172a; }

    @keyframes ripple { from { transform: scale(1); opacity: .8; } to { transform: scale(1.45); opacity: 0; } }
    @keyframes halo { from { transform: scale(1); opacity: .45; } to { transform: scale(2.6); opacity: 0; } }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var STYLES = ${JSON.stringify(MAP_STYLES)};
    var STALE_MS = ${STALE_AFTER_MS};
    var COLORS = ["#e11d48", "#ea580c", "#0284c7", "#4f46e5", "#db2777", "#2563eb", "#7c3aed", "#c026d3"];
    var dark = ${dark ? "true" : "false"};
    var markers = {};
    var selfMarker = null;
    var selectedId = null;
    var devices = [];
    // The day shown by the timeline: { segments, bottom, active }.
    var route = null;
    var stops = [];
    // Room above a chosen device for its popup, and below for the app's buttons.
    var PADDING = { top: 220, bottom: ${bottom + 30}, left: 40, right: 40 };
    document.documentElement.classList.toggle("dark", dark);

    function report(type, message) {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, message: String(message) }));
    }

    var map = new maplibregl.Map({
      container: "map", style: STYLES[dark ? "dark" : "light"], center: [10.45, 51.16], zoom: 4,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false
    });
    map.touchZoomRotate.disableRotation();
    function updateLabels() {
      document.getElementById("map").classList.toggle("show-labels", map.getZoom() >= ${LABEL_ZOOM});
    }
    map.on("zoom", updateLabels);
    updateLabels();
    map.on("error", function (e) { report("error", e.error && e.error.message); });
    // The OpenFreeMap styles name a few patterns their sprite does not have.
    map.on("styleimagemissing", function (e) {
      if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    var popup = new maplibregl.Popup({ anchor: "bottom", closeButton: false, closeOnClick: false, offset: [0, -64] });
    map.on("click", function (e) {
      if (e.originalEvent.target.closest && e.originalEvent.target.closest(".pin, .maplibregl-popup")) return;
      selectedId = null;
      popup.remove();
      sync();
    });

    // Device names come from other phones, never put them into HTML unescaped.
    function esc(text) {
      return String(text).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    function ago(ts) {
      if (!ts) return "no position yet";
      var s = Math.max(0, Math.floor((Date.now() - new Date(ts)) / 1000));
      if (s < 45) return "just now";
      if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
      if (s < 86400) return Math.floor(s / 3600) + " h ago";
      return Math.floor(s / 86400) + " d ago";
    }
    function state(d) {
      if (d.status !== "online") return "offline";
      if (d.lastPing && Date.now() - new Date(d.lastPing) > STALE_MS) return "stale";
      return "online";
    }
    function initials(name) {
      var words = String(name).trim().split(/[\\s._-]+/).filter(Boolean);
      var letters = words.length > 1 ? words[0][0] + words[1][0] : String(name).trim().slice(0, 2);
      return letters.toUpperCase() || "?";
    }
    function colour(name) {
      var hash = 0;
      for (var ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
      return COLORS[hash % COLORS.length];
    }
    // Device names are only unique per account, the key is "userId:deviceId".
    function keyOf(d) { return d.key || d.deviceId; }
    function ownerName(d) { return d.owner && d.owner.displayName ? d.owner.displayName : d.deviceId; }
    function fullName(d) { return d.owner && d.owner.displayName ? d.owner.displayName + " \u00b7 " + d.deviceId : d.deviceId; }
    function avatarHtml(d) {
      var inner = d.avatar ? '<img src="' + esc(d.avatar) + '" alt="">' : "<span>" + esc(initials(ownerName(d))) + "</span>";
      var bg = d.avatar ? "" : "background:" + colour(ownerName(d));
      return '<span class="avatar ' + state(d) + '" style="' + bg + '">' + inner + "</span>";
    }
    function popupHtml(d) {
      return '<div class="popup"><b>' + esc(fullName(d)) + "</b><span>" + (state(d) === "offline" ? "Offline" : "Online") + " · " + esc(ago(d.lastPing)) + "</span></div>";
    }

    function select(id) {
      selectedId = id;
      var d = devices.find(function (x) { return keyOf(x) === id; });
      if (d && d.position) map.easeTo({ center: [d.position.longitude, d.position.latitude], padding: PADDING, duration: 500 });
      sync();
    }

    function sync() {
      var seen = {};
      devices.forEach(function (d) {
        if (!d.position) return;
        var id = keyOf(d);
        seen[id] = true;
        var lngLat = [d.position.longitude, d.position.latitude];
        var key = state(d) + "|" + (d.avatar ? d.avatar.length + d.avatar.slice(-24) : "");
        var entry = markers[id];
        if (!entry) {
          var el = document.createElement("button");
          el.className = "pin";
          el.addEventListener("click", function (e) { e.stopPropagation(); select(id); });
          entry = markers[id] = { el: el, key: "", marker: new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -8] }).setLngLat(lngLat).addTo(map) };
        }
        entry.marker.setLngLat(lngLat);
        if (entry.key !== key) {
          entry.el.innerHTML = '<span class="pin-body ' + state(d) + '"><span class="bubble">' + avatarHtml(d) + '</span><span class="label">' + esc(fullName(d)) + "</span></span>";
          entry.key = key;
        }
        entry.el.classList.toggle("selected", id === selectedId);
      });
      Object.keys(markers).forEach(function (id) {
        if (!seen[id]) { markers[id].marker.remove(); delete markers[id]; }
      });
      var selected = devices.find(function (x) { return keyOf(x) === selectedId; });
      if (selected && selected.position) {
        popup.setLngLat([selected.position.longitude, selected.position.latitude]).setHTML(popupHtml(selected));
        if (!popup.isOpen()) popup.addTo(map);
      } else if (popup.isOpen()) {
        popup.remove();
      }
    }

    function lngLat(p) { return [p[1], p[0]]; }
    function routeData() {
      return {
        type: "FeatureCollection",
        features: route.segments.filter(function (s) { return s.type === "trip"; }).map(function (s) {
          return {
            type: "Feature",
            properties: { color: s.color, index: s.index, active: s.index === route.active ? 1 : 0 },
            geometry: { type: "LineString", coordinates: s.path.map(lngLat) }
          };
        })
      };
    }
    // A style change (theme) drops the source and layers, so this runs again on style.load.
    function drawLines() {
      if (!route) return;
      try {
        var source = map.getSource("route");
        if (source) { source.setData(routeData()); return; }
        map.addSource("route", { type: "geojson", data: routeData() });
        var width = function (a, b) { return ["case", ["==", ["get", "active"], 1], a, b]; };
        map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": dark ? "#0a0c10" : "#ffffff", "line-width": width(11, 8), "line-opacity": 0.9 } });
        map.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "color"], "line-width": width(7, 4.5) } });
      } catch (e) { /* the style is still loading, style.load tries again */ }
    }
    function removeLines() {
      try {
        ["route-line", "route-casing"].forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
        if (map.getSource("route")) map.removeSource("route");
      } catch (e) { /* ignore */ }
    }
    function clearStops() {
      stops.forEach(function (s) { s.marker.remove(); });
      stops = [];
    }
    function tellSegment(index) {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: "segment", index: index }));
    }
    function routePadding() { return { top: 110, bottom: route.bottom, left: 40, right: 40 }; }
    function fitRoute(index) {
      if (!route) return;
      var bounds = new maplibregl.LngLatBounds();
      var any = false;
      route.segments.forEach(function (s) {
        if (index !== null && index !== undefined && s.index !== index) return;
        if (s.type === "visit") { bounds.extend([s.lon, s.lat]); any = true; }
        else s.path.forEach(function (p) { bounds.extend(lngLat(p)); any = true; });
      });
      if (!any) return;
      map.fitBounds(bounds, { padding: routePadding(), maxZoom: 16.5, duration: 600 });
    }
    function setActive(index) {
      route.active = index;
      stops.forEach(function (s) { s.el.classList.toggle("active", s.index === index); });
      drawLines();
    }
    function showRoute(segments, bottom) {
      route = { segments: segments || [], bottom: bottom || 260, active: null };
      selectedId = null;
      sync();
      clearStops();
      route.segments.forEach(function (s) {
        if (s.type !== "visit") return;
        var el = document.createElement("button");
        el.className = "stop";
        el.textContent = String(s.number);
        el.addEventListener("click", function (e) { e.stopPropagation(); tellSegment(s.index); });
        stops.push({ index: s.index, el: el, marker: new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map) });
      });
      document.getElementById("map").classList.add("route-mode");
      removeLines();
      drawLines();
      fitRoute(null);
    }
    function clearRoute() {
      route = null;
      clearStops();
      removeLines();
      document.getElementById("map").classList.remove("route-mode");
    }
    map.on("style.load", drawLines);
    map.on("click", function (e) {
      if (!route || !map.getLayer("route-line")) return;
      var box = [[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]];
      var hit = map.queryRenderedFeatures(box, { layers: ["route-line"] });
      if (hit.length) tellSegment(hit[0].properties.index);
    });

    function updateSelf(lat, lng, center) {
      if (!selfMarker) {
        var el = document.createElement("div");
        el.className = "self";
        selfMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
        map.jumpTo({ center: [lng, lat], zoom: 13 });
      } else {
        selfMarker.setLngLat([lng, lat]);
        if (center) map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 13) });
      }
    }

    function handle(raw) {
      try {
        var data = JSON.parse(raw);
        if (data.type === "devices") { devices = data.devices || []; sync(); }
        else if (data.type === "self") updateSelf(data.latitude, data.longitude, data.center);
        else if (data.type === "focus") {
          var d = devices.find(function (x) { return keyOf(x) === data.key; });
          if (d && d.position) {
            selectedId = keyOf(d);
            sync();
            map.flyTo({ center: [d.position.longitude, d.position.latitude], zoom: Math.max(map.getZoom(), 15), padding: PADDING });
          }
        }
        else if (data.type === "route") showRoute(data.segments, data.bottom);
        else if (data.type === "routeFocus" && route) {
          setActive(data.index === null ? null : data.index);
          fitRoute(data.index);
        }
        else if (data.type === "routeClear") clearRoute();
        else if (data.type === "theme" && data.dark !== dark) {
          dark = data.dark;
          document.documentElement.classList.toggle("dark", dark);
          map.setStyle(STYLES[dark ? "dark" : "light"]);
        }
      } catch (e) {
        report("error", e);
      }
    }
    window.addEventListener("message", function (e) { handle(e.data); });
    document.addEventListener("message", function (e) { handle(e.data); });
    setInterval(sync, 15000);
  </script>
</body>
</html>`;
}

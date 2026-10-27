import { CLUSTER_RADIUS_PX, CLUSTER_SCRIPT } from "@/lib/cluster";
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
// { type: "routeBottom", bottom } when the panel over the map changes its height,
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
    .credit { position: absolute; left: 8px; bottom: calc(4px + ${bottom}px); z-index: 1; font: 10px system-ui, sans-serif; color: var(--muted); opacity: .75; pointer-events: none; }
    .maplibregl-ctrl-attrib { font-size: 10px; background: color-mix(in srgb, var(--surface) 80%, transparent) !important; color: var(--muted); }
    .maplibregl-ctrl-attrib a { color: inherit; }
    .dark .maplibregl-ctrl-attrib-button { filter: invert(1); }
    .maplibregl-ctrl-bottom-left, .maplibregl-ctrl-bottom-right { margin-bottom: ${bottom}px; }

    .pin { display: block; border: 0; background: none; padding: 0; }
    .pin.selected { z-index: 5; }
    .pin.clustered { display: none; }
    .route-mode .cluster { display: none; }
    .cluster { display: block; border: 0; background: none; padding: 0; }
    .cluster-body { position: relative; display: flex; align-items: center; padding: 4px; border-radius: 999px; background: var(--surface); box-shadow: var(--shadow); }
    .cluster .avatar { width: 30px; height: 30px; font-size: 12px; }
    .cluster .avatar + .avatar { margin-left: -9px; }
    .cluster-count { position: absolute; top: -9px; right: -9px; display: grid; place-items: center; min-width: 21px; height: 21px; padding: 0 5px; border: 2px solid var(--surface); border-radius: 11px; background: #d3171e; color: #fff; font: 700 11px system-ui, sans-serif; }
    .cluster-list { display: flex; flex-direction: column; gap: 2px; max-width: 240px; max-height: 200px; overflow-y: auto; }
    .cluster-row { display: flex; align-items: center; gap: 10px; border: 0; border-radius: 10px; background: none; padding: 5px 6px; color: var(--text); font: 600 13px system-ui, sans-serif; text-align: left; }
    .cluster-row:active { background: var(--bg); }
    .cluster-row .avatar { flex: none; width: 28px; height: 28px; font-size: 11px; }
    .cluster-row span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pin-body { position: relative; display: flex; flex-direction: column; align-items: center; transform-origin: 50% 100%; transition: transform .2s; }
    .pin.selected .pin-body { transform: scale(1.12); }
    .bubble { position: relative; padding: 5px; border-radius: 50%; background: var(--surface); box-shadow: var(--shadow); }
    .bubble::after { content: ""; position: absolute; left: 50%; bottom: -5px; z-index: -1; width: 13px; height: 13px; border-radius: 3px; background: var(--surface); transform: translateX(-50%) rotate(45deg); }
    .avatar { position: relative; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; color: #fff; font: 700 15px system-ui, sans-serif;
      box-shadow: 0 0 0 2px var(--surface), 0 0 0 4.5px var(--ring); }
    .dtype { position: absolute; right: -3px; bottom: -1px; display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
    .dtype svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
    .avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
    .online { --ring: ${STATE_COLORS.online}; }
    .stale { --ring: ${STATE_COLORS.stale}; }
    .offline { --ring: ${STATE_COLORS.offline}; }
    .offline.avatar { background: ${STATE_COLORS.offline} !important; }
    .offline.avatar > * { filter: grayscale(1); opacity: .7; }
    /* Two rings that only fade in and out: opacity animates on the GPU without repainting the map. */
    .pin .online.avatar::before, .pin .online.avatar::after { content: ""; position: absolute; border-radius: 50%; border: 2px solid ${STATE_COLORS.online}; opacity: 0; pointer-events: none; animation: breathe 2.6s ease-in-out infinite; }
    .pin .online.avatar::before { inset: -4.5px; }
    .pin .online.avatar::after { inset: -10px; animation-delay: .45s; }
    #map.is-moving .self::after { animation-play-state: paused; }
    .label { position: absolute; top: calc(100% + 9px); max-width: 140px; overflow: hidden; padding: 2px 8px; border-radius: 999px; background: var(--surface); color: var(--text);
      box-shadow: var(--shadow); font-size: 11.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap;
      opacity: 0; transform: translateY(-4px); transition: opacity .2s, transform .2s; pointer-events: none; }
    .show-labels .label, .pin.selected .label { opacity: 1; transform: none; }
    .offline .label { color: var(--muted); }
    .self { width: 20px; height: 20px; border-radius: 50%; background: #d3171e; border: 3px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.15), 0 2px 8px rgba(0,0,0,.35); }
    .self::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: #d3171e; opacity: .35; animation: halo 5s ease-out infinite; pointer-events: none; z-index: -1; will-change: transform, opacity; backface-visibility: hidden; }

    .maplibregl-popup-content { padding: 12px 14px; border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); font: 13px/1.4 system-ui, sans-serif; }
    .maplibregl-popup-anchor-bottom .maplibregl-popup-tip { border-top-color: var(--surface); }
    .popup b { display: block; max-width: 200px; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
    .popup span { color: var(--muted); font-size: 12px; }

    .route-mode .pin { display: none; }
    .stop { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 2.5px solid #fff; border-radius: 50%; background: #d3171e; color: #fff;
      box-shadow: var(--shadow); font: 700 13px system-ui, sans-serif; transition: box-shadow .15s; }
    .stop.active { z-index: 6; background: #0f172a; box-shadow: 0 0 0 4px rgba(15,23,42,.25), var(--shadow); }
    .dark .stop.active { background: #fff; color: #0f172a; border-color: #0f172a; }

    @keyframes breathe { 0%, 100% { opacity: 0; } 45% { opacity: .85; } }
    @keyframes ripple { 0% { transform: scale(1); opacity: .75; } 25%, 100% { transform: scale(1.4); opacity: 0; } }
    @keyframes halo { 0% { transform: scale(1); opacity: .4; } 30%, 100% { transform: scale(2.4); opacity: 0; } }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="credit">© OpenStreetMap · OpenFreeMap</div>
  <script>
    var STYLES = ${JSON.stringify(MAP_STYLES)};
    var STALE_MS = ${STALE_AFTER_MS};
    var COLORS = ["#e11d48", "#ea580c", "#0284c7", "#4f46e5", "#db2777", "#2563eb", "#7c3aed", "#c026d3"];
    var dark = ${dark ? "true" : "false"};
    var markers = {};
    var selfMarker = null;
    var selectedId = null;
    var devices = [];
    var clusters = {};
    var CLUSTER_RADIUS = ${CLUSTER_RADIUS_PX};
    // Mercator px per degree at zoom 18 (512 px tiles), to tell whether zooming can still pull a cluster apart.
    var PX_PER_DEG_Z18 = 512 * Math.pow(2, 18) / 360;
    var STATE_RANK = { online: 0, stale: 1, offline: 2 };
    ${CLUSTER_SCRIPT}
    // The day shown by the timeline: { segments, bottom, active }.
    var route = null;
    var stops = [];
    // Room above a chosen device for its popup, and below for the app's buttons.
    var PADDING = { top: 220, bottom: ${bottom + 30}, left: 40, right: 40 };
    document.documentElement.classList.toggle("dark", dark);

    function report(type, message) {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, message: String(message) }));
    }

    // The stock dark style is nearly black, so roads and water are hard to tell apart.
    var DARK_TUNE = {
      background: { "background-color": "#161c27" },
      water: { "fill-color": "#1f3a57" },
      waterway: { "line-color": "#1f3a57" },
      landcover_wood: { "fill-color": "#1c2f2a" },
      landuse_park: { "fill-color": "#1c2f2a" },
      landuse_residential: { "fill-color": "#1a2130" },
      building: { "fill-color": "#262f40" },
      highway_path: { "line-color": "#35415a" },
      highway_minor: { "line-color": "#3d4a62" },
      highway_major_casing: { "line-color": "#202838" },
      highway_major_inner: { "line-color": "#53607a" },
      highway_major_subtle: { "line-color": "#46536c" },
      highway_motorway_casing: { "line-color": "#2a3448" },
      highway_motorway_subtle: { "line-color": "#46536c" },
      railway: { "line-color": "#46536c" },
      boundary_state: { "line-color": "#56637d" },
      "boundary_country_z0-4": { "line-color": "#6a7893" },
      "boundary_country_z5-": { "line-color": "#6a7893" },
      highway_name_other: { "text-color": "#a3aec3" },
      highway_name_motorway: { "text-color": "#b4bfd3" },
      water_name: { "text-color": "#8fa6c4", "text-halo-color": "rgba(10,14,22,0.7)" }
    };
    ["other", "suburb", "village", "town", "city", "city_large", "state", "country_other", "country_minor", "country_major"].forEach(function (id) {
      DARK_TUNE["place_" + id] = { "text-color": "#c4cde0", "text-halo-color": "rgba(10,14,22,0.8)" };
    });
    function transformStyle(isDark) {
      return function (previous, next) {
        if (!isDark) return next;
        next.layers.forEach(function (layer) {
          var paint = DARK_TUNE[layer.id];
          if (paint) layer.paint = Object.assign({}, layer.paint, paint);
        });
        return next;
      };
    }
    var map = new maplibregl.Map({
      container: "map", style: STYLES[dark ? "dark" : "light"], center: [10.45, 51.16], zoom: 4,
      attributionControl: false, renderWorldCopies: false, minZoom: 1.5, dragRotate: false, pitchWithRotate: false
    });
    if (dark) map.setStyle(STYLES.dark, { diff: false, transformStyle: transformStyle(true) });
    map.touchZoomRotate.disableRotation();
    function updateLabels() {
      document.getElementById("map").classList.toggle("show-labels", map.getZoom() >= ${LABEL_ZOOM});
    }
    map.on("zoom", updateLabels);
    map.on("movestart", function () { map.getContainer().classList.add("is-moving"); });
    map.on("moveend", function () { map.getContainer().classList.remove("is-moving"); });
    updateLabels();
    map.on("error", function (e) { report("error", e.error && e.error.message); });
    // The OpenFreeMap styles name a few patterns their sprite does not have.
    map.on("styleimagemissing", function (e) {
      if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    var popup = new maplibregl.Popup({ anchor: "bottom", closeButton: false, closeOnClick: false, offset: [0, -64] });
    map.on("click", function (e) {
      if (e.originalEvent.target.closest && e.originalEvent.target.closest(".pin, .cluster, .maplibregl-popup")) return;
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
    var TYPE_PATHS = {
      phone: '<rect width="12" height="20" x="6" y="2" rx="2.5"/><path d="M11 18h2"/>',
      tablet: '<rect width="20" height="16" x="2" y="4" rx="2.5"/><path d="M18 12h.01"/>',
      desktop: '<rect width="16" height="11" x="4" y="5" rx="2"/><path d="M2 20h20"/>'
    };
    function typeBadge(d) {
      var paths = TYPE_PATHS[d.deviceType] || TYPE_PATHS.phone;
      return '<span class="dtype"><svg viewBox="0 0 24 24">' + paths + "</svg></span>";
    }
    function avatarHtml(d) {
      var inner = d.avatar ? '<img src="' + esc(d.avatar) + '" alt="">' : "<span>" + esc(initials(ownerName(d))) + "</span>";
      var bg = d.avatar ? "" : "background:" + colour(ownerName(d));
      return '<span class="avatar ' + state(d) + '" style="' + bg + '">' + inner + "</span>";
    }
    // "64 %" or "100 %, charging", only while the device is online.
    function batteryText(d) {
      if (d.status !== "online" || !d.battery) return "";
      return " · " + Math.round(d.battery.level) + " %" + (d.battery.charging ? ", charging" : "");
    }
    function popupHtml(d) {
      return '<div class="popup"><b>' + esc(fullName(d)) + "</b><span>" + (state(d) === "offline" ? "Offline" : "Online") + " · " + esc(ago(d.lastPing)) + esc(batteryText(d)) + "</span></div>";
    }

    function select(id) {
      clusterPopup.remove();
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
        var key = state(d) + "|" + (d.deviceType || "") + "|" + (d.avatar ? d.avatar.length + d.avatar.slice(-24) : "");
        var entry = markers[id];
        if (!entry) {
          var el = document.createElement("button");
          el.className = "pin";
          el.addEventListener("click", function (e) { e.stopPropagation(); select(id); });
          entry = markers[id] = { el: el, key: "", marker: new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -8] }).setLngLat(lngLat).addTo(map) };
        }
        entry.marker.setLngLat(lngLat);
        if (entry.key !== key) {
          entry.el.innerHTML = '<span class="pin-body ' + state(d) + '"><span class="bubble">' + avatarHtml(d) + typeBadge(d) + '</span><span class="label">' + esc(fullName(d)) + "</span></span>";
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
      layout();
    }

    function ownerOf(d) {
      if (d.userId !== undefined && d.userId !== null) return "u" + d.userId;
      return d.owner && d.owner.username ? "n" + d.owner.username : "d" + keyOf(d);
    }
    // One avatar per person, the person's best state wins when several devices are in the cluster.
    function bestByOwner(members) {
      var best = {}, order = [];
      members.forEach(function (d) {
        var o = ownerOf(d);
        if (!best[o]) { best[o] = d; order.push(o); }
        else if (STATE_RANK[state(d)] < STATE_RANK[state(best[o])]) best[o] = d;
      });
      return order.map(function (o) { return best[o]; });
    }
    function clusterHtml(members) {
      var people = bestByOwner(members);
      var badge = people.length > 1 ? '<span class="cluster-count">' + people.length + "</span>" : "";
      return '<span class="cluster-body">' + people.slice(0, 3).map(avatarHtml).join("") + badge + "</span>";
    }
    var clusterPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 30 });
    function showClusterList(entry) {
      var box = document.createElement("div");
      box.className = "cluster-list";
      bestByOwner(entry.members).forEach(function (d) {
        var row = document.createElement("button");
        row.className = "cluster-row";
        row.innerHTML = avatarHtml(d) + "<span>" + esc(fullName(d)) + "</span>";
        row.addEventListener("click", function () { focusDevice(d); });
        box.appendChild(row);
      });
      clusterPopup.setLngLat(entry.marker.getLngLat()).setDOMContent(box).addTo(map);
    }
    function openCluster(id) {
      var entry = clusters[id];
      if (!entry) return;
      var bounds = new maplibregl.LngLatBounds();
      entry.members.forEach(function (d) { bounds.extend([d.position.longitude, d.position.latitude]); });
      var span = Math.max(bounds.getEast() - bounds.getWest(), bounds.getNorth() - bounds.getSouth());
      // Close enough that even the deepest zoom keeps them together: list the people instead.
      if (span * PX_PER_DEG_Z18 < CLUSTER_RADIUS || map.getZoom() >= 17.5) showClusterList(entry);
      else map.fitBounds(bounds, { padding: PADDING, maxZoom: 18, duration: 500 });
    }
    // Pins closer than the radius on screen become one marker, the selected device always stays a pin.
    function layout() {
      var byKey = {};
      var pins = [];
      devices.forEach(function (d) {
        if (!d.position) return;
        var p = map.project([d.position.longitude, d.position.latitude]);
        byKey[keyOf(d)] = d;
        pins.push({ key: keyOf(d), x: p.x, y: p.y, owner: ownerOf(d), fixed: keyOf(d) === selectedId });
      });
      var live = {};
      clusterPins(pins, CLUSTER_RADIUS).forEach(function (group) {
        var single = group.keys.length === 1;
        group.keys.forEach(function (k) { if (markers[k]) markers[k].el.classList.toggle("clustered", !single); });
        if (single) return;
        var id = group.keys.join("|");
        live[id] = true;
        var members = group.keys.map(function (k) { return byKey[k]; });
        var at = map.unproject([group.x, group.y]);
        var sig = members.map(function (d) { return keyOf(d) + state(d) + (d.avatar ? d.avatar.length + d.avatar.slice(-24) : ""); }).join("|");
        var entry = clusters[id];
        if (!entry) {
          var el = document.createElement("button");
          el.className = "cluster";
          el.addEventListener("click", function (e) { e.stopPropagation(); openCluster(id); });
          entry = clusters[id] = { el: el, sig: "", members: members, marker: new maplibregl.Marker({ element: el }).setLngLat(at).addTo(map) };
        }
        entry.members = members;
        entry.marker.setLngLat(at);
        if (entry.sig !== sig) { entry.el.innerHTML = clusterHtml(members); entry.sig = sig; }
      });
      Object.keys(clusters).forEach(function (id) {
        if (!live[id]) { clusters[id].marker.remove(); delete clusters[id]; }
      });
    }
    map.on("zoomend", layout);
    map.on("moveend", layout);

    function focusDevice(d) {
      clusterPopup.remove();
      selectedId = keyOf(d);
      sync();
      map.flyTo({ center: [d.position.longitude, d.position.latitude], zoom: Math.max(map.getZoom(), 15), padding: PADDING });
    }

    function lngLat(p) { return [p[1], p[0]]; }
    function routeData() {
      return {
        type: "FeatureCollection",
        features: route.segments.filter(function (s) { return s.type === "trip"; }).map(function (s) {
          return {
            type: "Feature",
            properties: { color: s.color, index: s.index, active: s.index === route.active ? 1 : 0, gap: s.gap ? 1 : 0 },
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
        var solid = ["==", ["get", "gap"], 0];
        map.addLayer({ id: "route-gap", type: "line", source: "route", filter: ["==", ["get", "gap"], 1], layout: { "line-cap": "round" },
          paint: { "line-color": ["get", "color"], "line-width": width(4, 3), "line-dasharray": [1.5, 2.5] } });
        map.addLayer({ id: "route-casing", type: "line", source: "route", filter: solid, layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": dark ? "#0a0c10" : "#ffffff", "line-width": width(11, 8), "line-opacity": 0.9 } });
        map.addLayer({ id: "route-line", type: "line", source: "route", filter: solid, layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "color"], "line-width": width(7, 4.5) } });
      } catch (e) { /* the style is still loading, style.load tries again */ }
    }
    function removeLines() {
      try {
        ["route-line", "route-casing", "route-gap"].forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
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
      var hit = map.queryRenderedFeatures(box, { layers: ["route-line", "route-gap"] });
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
          if (d && d.position) focusDevice(d);
        }
        else if (data.type === "route") showRoute(data.segments, data.bottom);
        else if (data.type === "routeFocus" && route) {
          setActive(data.index === null ? null : data.index);
          fitRoute(data.index);
        }
        else if (data.type === "routeBottom" && route) {
          route.bottom = data.bottom;
          fitRoute(route.active);
        }
        else if (data.type === "routeClear") clearRoute();
        else if (data.type === "theme" && data.dark !== dark) {
          dark = data.dark;
          document.documentElement.classList.toggle("dark", dark);
          map.setStyle(STYLES[dark ? "dark" : "light"], { diff: false, transformStyle: transformStyle(dark) });
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

const STALE_AFTER_MS = 10 * 60 * 1000;
// From this zoom on every pin shows its name without being touched.
const LABEL_ZOOM = 14;
// OpenFreeMap serves vector tiles without an API key. One style per theme.
const MAP_STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const STATE_LABELS = { online: "Online", stale: "No recent position", offline: "Offline" };
const STATE_ORDER = { online: 0, stale: 1, offline: 2 };

const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const onlineCountEl = document.getElementById("onlineCount");
const totalCountEl = document.getElementById("totalCount");
const listEl = document.getElementById("deviceList");
const stackEl = document.getElementById("avatarStack");
const panel = document.getElementById("devicesPanel");
const panelToggle = document.getElementById("panelToggle");
const refreshButton = document.getElementById("refreshButton");
const toastEl = document.getElementById("toast");
const mapEl = document.getElementById("map");
const phone = window.matchMedia("(max-width: 767px)");

const markers = new Map();
// Everything the server sends, and the part that passes the group filter.
let allDevices = [];
let devices = [];
// A group id, or null for everybody.
let groupFilter = null;
let selectedId = null;
let socket = null;
let reconnectTimer = null;
let fittedOnce = false;
let toastTimer = null;

// Device names come from the phones, never put them into HTML unescaped.
// Device names are only unique per account, so a device is known by owner and name.
const keyOf = (device) => `${device.userId}:${device.deviceId}`;
const isOwn = (device) => typeof me !== "undefined" && me !== null && device.userId === me.id;
const ownerName = (device) => device.owner?.displayName || device.owner?.username || "";
// "Luis · iPhone"
const fullName = (device) => (ownerName(device) ? `${ownerName(device)} · ${device.deviceId}` : device.deviceId);

const TYPE_ICONS = { phone: "i-phone", tablet: "i-tablet", desktop: "i-laptop" };
const TYPE_LABELS = { phone: "Phone", tablet: "Tablet", desktop: "Computer" };

// Older servers send no type, those devices are phones.
function typeIcon(device, extra = "") {
  const type = TYPE_ICONS[device.deviceType] ? device.deviceType : "phone";
  return `<svg class="icon dtype${extra}" role="img" aria-label="${TYPE_LABELS[type]}"><use href="#${TYPE_ICONS[type]}" /></svg>`;
}

// The charge as a small battery with its percent. Only while the device is online:
// the last reading of a phone that went offline would only mislead.
function batteryHtml(device) {
  const battery = device.battery;
  if (!battery || device.status !== "online") return "";
  const level = Math.max(0, Math.min(100, Math.round(battery.level)));
  const state = battery.charging ? "charging" : level <= 20 ? "low" : "ok";
  const label = `Battery ${level} %${battery.charging ? ", charging" : ""}`;
  const bolt = battery.charging ? '<svg class="icon battery__bolt" aria-hidden="true"><use href="#i-bolt" /></svg>' : "";
  return `<span class="battery battery--${state}" role="img" aria-label="${label}" title="${label}"><span class="battery__cell"><span class="battery__fill" style="width:${level}%"></span></span>${level} %${bolt}</span>`;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function timeAgo(timestamp) {
  if (!timestamp) return "no position yet";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function freshness(device) {
  if (device.status !== "online") return "offline";
  if (device.lastPing && Date.now() - new Date(device.lastPing) > STALE_AFTER_MS) return "stale";
  return "online";
}

function initials(name) {
  const words = String(name).trim().split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : String(name).trim().slice(0, 2);
  return letters.toUpperCase() || "?";
}

// The same name always gets the same colour, in the app too.
function colourClass(name) {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `avatar--c${hash % 8}`;
}

// The picture comes from avatarUrl only, so where it is stored can change without touching this.
// A person's row passes their own name for the letters and colour, pins use the device's.
function avatarHtml(device, size = "", { label = device.deviceId, colour = keyOf(device) } = {}) {
  const inner = device.avatarUrl
    ? `<img src="${esc(device.avatarUrl)}" alt="" decoding="async" />`
    : `<span>${esc(initials(label))}</span>`;
  const sizeClass = size ? ` avatar--${size}` : "";
  return `<span class="avatar${sizeClass} ${colourClass(colour)}" data-state="${freshness(device)}">${inner}</span>`;
}

function metaText(device) {
  const state = freshness(device);
  if (state === "offline") return device.lastPing ? `Offline · seen ${timeAgo(device.lastPing)}` : "Offline";
  return device.lastPing ? timeAgo(device.lastPing) : "Online · no position yet";
}

// The panel's subtitle doubles as the connection state: device count while
// connected, otherwise what the socket is doing.
function setStatus(state) {
  statusEl.dataset.state = state;
  updateSummary();
}

function updateSummary() {
  const state = statusEl.dataset.state;
  const online = devices.filter((d) => d.status === "online").length;
  if (state === "connecting") summaryEl.textContent = "Connecting…";
  else if (state === "offline") summaryEl.textContent = "Reconnecting…";
  else summaryEl.textContent = devices.length === 0 ? "Connected · no devices yet" : `${online} of ${devices.length} connected`;
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 3200);
}

function hideLoader() {
  document.getElementById("loader").classList.add("is-hidden");
}

// Map

// The stock dark style is nearly black, so roads and water are hard to tell apart. This
// lifts them into a slate palette.
const DARK_TUNE = {
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
  boundary_country_z0_4: { "line-color": "#6a7893" },
  "boundary_country_z0-4": { "line-color": "#6a7893" },
  "boundary_country_z5-": { "line-color": "#6a7893" },
  highway_name_other: { "text-color": "#a3aec3" },
  highway_name_motorway: { "text-color": "#b4bfd3" },
  water_name: { "text-color": "#8fa6c4", "text-halo-color": "rgba(10,14,22,0.7)" },
};
for (const id of ["other", "suburb", "village", "town", "city", "city_large", "state", "country_other", "country_minor", "country_major"]) {
  DARK_TUNE["place_" + id] = { "text-color": "#c4cde0", "text-halo-color": "rgba(10,14,22,0.8)" };
}

function tuneDark(style) {
  for (const layer of style.layers) {
    const paint = DARK_TUNE[layer.id];
    if (paint) layer.paint = Object.assign({}, layer.paint, paint);
  }
  return style;
}

const transformStyle = (dark) => (_previous, next) => (dark ? tuneDark(next) : next);

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLES[window.neopinTheme.get()],
  center: [10.45, 51.16],
  zoom: 5,
  attributionControl: false,
  // One world only: no endless copies of the map when zooming out or panning sideways.
  renderWorldCopies: false,
  minZoom: 1.5,
  dragRotate: false,
  pitchWithRotate: false,
});
if (window.neopinTheme.get() === "dark") {
  map.setStyle(MAP_STYLES.dark, { diff: false, transformStyle: transformStyle(true) });
}
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();

class FitControl {
  onAdd() {
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this.container.innerHTML =
      '<button type="button" class="fit-button" aria-label="Show all devices" title="Show all devices"><svg class="icon"><use href="#i-fit" /></svg></button>';
    this.container.querySelector("button").addEventListener("click", () => fitAll(true));
    return this.container;
  }
  onRemove() {
    this.container.remove();
  }
}

map.addControl(new FitControl(), "bottom-right");
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

// The OpenFreeMap styles name a few fill patterns their sprite does not have.
// An empty image keeps the console clean instead of warning on every tile.
map.on("styleimagemissing", (event) => {
  if (!map.hasImage(event.id)) map.addImage(event.id, { width: 1, height: 1, data: new Uint8Array(4) });
});

const updateLabels = () => mapEl.classList.toggle("show-labels", map.getZoom() >= LABEL_ZOOM);
map.on("zoom", updateLabels);
// Pause the pulse rings while the map moves.
map.on("movestart", () => map.getContainer().classList.add("is-moving"));
map.on("moveend", () => map.getContainer().classList.remove("is-moving"));
updateLabels();

document.documentElement.addEventListener("themechange", (event) => {
  // Markers are DOM elements and survive the style swap.
  // No diffing: a diff would quietly remove the timeline's own source instead of reloading.
  map.setStyle(MAP_STYLES[event.detail], { diff: false, transformStyle: transformStyle(event.detail === "dark") });
});

// Always above the pin, select() moves the map so there is room for it.
const popup = new maplibregl.Popup({
  anchor: "bottom",
  closeButton: false,
  closeOnClick: false,
  offset: [0, -66],
  maxWidth: "280px",
  focusAfterOpen: false,
});
popup.on("close", () => {
  if (selectedId === null) return;
  selectedId = null;
  render();
});

// Clicks on a pin or the popup reach the map too, only empty map deselects.
map.on("click", (event) => {
  if (event.originalEvent.target.closest?.(".pin, .maplibregl-popup")) return;
  select(null);
});

// Room for the HUD and the device panel, so a device never hides behind them.
function mapPadding() {
  const box = panel.getBoundingClientRect();
  if (phone.matches) return { top: 100, bottom: window.innerHeight - box.top + 60, left: 70, right: 70 };
  const expanded = panel.dataset.expanded === "true";
  return { top: 120, bottom: 80, left: expanded ? box.right + 70 : 90, right: 110 };
}

// The map keeps the padding of its last move and adds new padding on top when it fits bounds.
// Measuring against a flat map and then easing there keeps repeated fits right.
function fitBoundsTo(bounds, padding, duration, maxZoom = 15) {
  const kept = map.getPadding();
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  const camera = map.cameraForBounds(bounds, { padding, maxZoom });
  map.setPadding(kept);
  // With the padding set, the middle of the bounds belongs in the middle of the free area.
  if (camera) map.easeTo({ center: bounds.getCenter(), zoom: camera.zoom, padding, duration });
}

function located() {
  return devices.filter((d) => d.position);
}

function fitAll(animate) {
  const points = located().map((d) => [d.position.longitude, d.position.latitude]);
  if (points.length === 0) {
    if (animate) toast("No device has sent a position yet.");
    return;
  }
  const padding = mapPadding();
  const duration = animate ? 900 : 0;
  if (points.length === 1) {
    map.easeTo({ center: points[0], zoom: 14, padding, duration });
    return;
  }
  const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
  fitBoundsTo(bounds, padding, duration);
}

function pinHtml(device) {
  return `<span class="pin__body"><span class="pin__bubble">${avatarHtml(device)}${typeIcon(device, " dtype--badge")}</span><span class="pin__label">${esc(fullName(device))}</span></span>`;
}

// Pins closer than this on the screen merge into one cluster marker.
const CLUSTER_PX = 56;
const CLUSTER_MAX_ZOOM = 18;
const clusterMarkers = new Map();
const clusterPopup = new maplibregl.Popup({ closeButton: false, offset: 24, maxWidth: "300px", focusAfterOpen: false });

// One representative device per person, the same pick the people list makes.
function peopleOf(members) {
  const byUser = new Map();
  for (const device of members) {
    if (!byUser.has(device.userId)) byUser.set(device.userId, []);
    byUser.get(device.userId).push(device);
  }
  return [...byUser.values()].map((list) => {
    list.sort(comparePrimary);
    return { device: list[0], devices: list };
  });
}

function clusterHtml(people) {
  const shown = people.slice(0, 3);
  const avatars = shown
    .map(({ device }) => avatarHtml(device, "sm", { label: ownerName(device), colour: `user:${device.userId}` }))
    .join("");
  const badge = people.length > 1 ? `<span class="cluster__count">${people.length}</span>` : "";
  return `<span class="cluster__avatars">${avatars}</span>${badge}`;
}

function updateClusters() {
  const byId = new Map(located().map((d) => [keyOf(d), d]));
  const points = [...byId.keys()].sort().map((id) => {
    const d = byId.get(id);
    const p = map.project([d.position.longitude, d.position.latitude]);
    return { id, x: p.x, y: p.y };
  });
  // The selected device stays a pin of its own, so its popup always has something to sit on.
  const groups = clusterPoints(points, CLUSTER_PX, new Set(selectedId ? [selectedId] : []));
  const live = new Set();
  const hidden = new Set();

  for (const group of groups) {
    if (group.ids.length < 2) continue;
    const members = group.ids.map((id) => byId.get(id));
    const key = group.ids.join("|");
    live.add(key);
    group.ids.forEach((id) => hidden.add(id));
    const lng = members.reduce((s, d) => s + d.position.longitude, 0) / members.length;
    const lat = members.reduce((s, d) => s + d.position.latitude, 0) / members.length;
    const people = peopleOf(members);

    let entry = clusterMarkers.get(key);
    if (!entry) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "cluster";
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        openCluster(clusterMarkers.get(key));
      });
      entry = { marker: new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map), el, key: "", members };
      clusterMarkers.set(key, entry);
    }
    entry.members = members;
    entry.marker.setLngLat([lng, lat]);
    const sig = people.map(({ device }) => `${device.userId}|${device.avatarUrl}|${freshness(device)}|${ownerName(device)}`).join(";");
    if (entry.key !== sig) {
      entry.el.innerHTML = clusterHtml(people);
      entry.key = sig;
      const names = people.map(({ device }) => ownerName(device)).join(", ");
      entry.el.setAttribute("aria-label", `${people.length === 1 ? names : `${people.length} people: ${names}`}, ${members.length} ${members.length === 1 ? "device" : "devices"} close together`);
    }
  }

  for (const [key, entry] of clusterMarkers) {
    if (!live.has(key)) {
      entry.marker.remove();
      clusterMarkers.delete(key);
    }
  }
  for (const [id, entry] of markers) entry.el.classList.toggle("is-clustered", hidden.has(id));
  if (clusterPopup.isOpen() && clusterMarkers.size === 0) clusterPopup.remove();
}

// Spread of the members in pixels at the highest zoom, to know whether zooming can pull them apart.
function spreadAtMaxZoom(bounds) {
  const a = maplibregl.MercatorCoordinate.fromLngLat(bounds.getSouthWest());
  const b = maplibregl.MercatorCoordinate.fromLngLat(bounds.getNorthEast());
  return Math.hypot(b.x - a.x, b.y - a.y) * 512 * 2 ** CLUSTER_MAX_ZOOM;
}

function openCluster(entry) {
  const members = entry.members;
  const first = [members[0].position.longitude, members[0].position.latitude];
  const bounds = members.reduce((b, d) => b.extend([d.position.longitude, d.position.latitude]), new maplibregl.LngLatBounds(first, first));
  if (spreadAtMaxZoom(bounds) > CLUSTER_PX && map.getZoom() < CLUSTER_MAX_ZOOM - 0.1) {
    clusterPopup.remove();
    fitBoundsTo(bounds, { top: 140, bottom: 100, left: phone.matches ? 60 : mapPadding().left, right: phone.matches ? 60 : 110 }, 700, CLUSTER_MAX_ZOOM);
    return;
  }
  // Zooming cannot separate them: list the people instead.
  const rows = members
    .slice()
    .sort(comparePrimary)
    .map((device) => {
      const state = freshness(device);
      return `
        <button class="cluster-row" type="button" data-pick="${esc(keyOf(device))}" data-state="${state}">
          ${avatarHtml(device, "sm", { label: ownerName(device), colour: `user:${device.userId}` })}
          <span class="cluster-row__text">
            <strong>${esc(ownerName(device))}</strong>
            <span>${typeIcon(device)}${esc(device.deviceId)} · ${esc(STATE_LABELS[state])}</span>
          </span>
        </button>`;
    })
    .join("");
  clusterPopup.setLngLat(entry.marker.getLngLat()).setHTML(`<div class="cluster-list">${rows}</div>`).addTo(map);
  clusterPopup.getElement().querySelectorAll("[data-pick]").forEach((button) =>
    button.addEventListener("click", () => {
      clusterPopup.remove();
      select(button.dataset.pick, { zoomIn: false });
    })
  );
}

map.on("zoomend", updateClusters);
map.on("moveend", updateClusters);

function syncMarkers() {
  const seen = new Set();
  for (const device of located()) {
    const id = keyOf(device);
    const state = freshness(device);
    const lngLat = [device.position.longitude, device.position.latitude];
    seen.add(id);

    let entry = markers.get(id);
    if (!entry) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "pin";
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        select(id, { zoomIn: false });
      });
      const marker = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -8] }).setLngLat(lngLat).addTo(map);
      entry = { marker, el, key: "" };
      markers.set(id, entry);
    }

    entry.marker.setLngLat(lngLat);
    const key = `${state}|${device.deviceType}|${device.avatarUrl}|${fullName(device)}`;
    if (entry.key !== key) {
      entry.el.innerHTML = pinHtml(device);
      entry.el.dataset.state = state;
      entry.el.setAttribute("aria-label", `${fullName(device)}, ${STATE_LABELS[state]}`);
      entry.key = key;
    }
    entry.el.classList.toggle("is-selected", id === selectedId);
  }

  for (const [id, entry] of markers) {
    if (!seen.has(id)) {
      entry.marker.remove();
      markers.delete(id);
    }
  }
  updateClusters();
}

function popupHtml(device) {
  const state = freshness(device);
  const coords = device.position
    ? `${device.position.latitude.toFixed(5)}, ${device.position.longitude.toFixed(5)}`
    : "No position yet";
  return `
    <div class="popup">
      <div class="popup__head">
        ${avatarHtml(device, "lg")}
        <div>
          <strong class="popup__name">${esc(fullName(device))}</strong>
          <span class="popup__state">${typeIcon(device)}${esc(STATE_LABELS[state])} · ${esc(timeAgo(device.lastPing))}${batteryHtml(device)}</span>
        </div>
      </div>
      <p class="popup__coords">${coords}</p>
      ${state === "offline" ? "" : '<button class="btn btn--small btn--ghost" type="button" data-ping>Ask for a fresh position</button>'}
    </div>`;
}

function syncPopup() {
  const device = devices.find((d) => keyOf(d) === selectedId);
  if (!device?.position) {
    if (popup.isOpen()) popup.remove();
    return;
  }
  popup.setLngLat([device.position.longitude, device.position.latitude]).setHTML(popupHtml(device));
  if (!popup.isOpen()) popup.addTo(map);
  popup.getElement().querySelector("[data-ping]")?.addEventListener("click", (event) => pingDevice(device, event.currentTarget));
}

async function pingDevice(device, button) {
  const labelled = !button.classList.contains("icon-btn");
  button.disabled = true;
  if (labelled) button.textContent = "Asking…";
  try {
    const response = await fetch("/api/sendPing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, userId: device.userId }),
    });
    if (response.status === 401) return (window.location.href = "/login");
    if (!response.ok) toast("The device is not connected right now.");
  } catch {
    toast("The server is not reachable.");
  }
  // The answer arrives over the socket and redraws the popup.
  if (button.isConnected) {
    button.disabled = false;
    if (labelled) button.textContent = "Ask for a fresh position";
  }
}

// Device panel

const TYPE_RANK = { phone: 0, tablet: 1, desktop: 2 };

// The device that stands for a person: the one online, among those the one its owner
// picked, else phone over tablet over computer, else the one that reported last. A picked
// device that is offline gives way to one that is online, and comes back with it.
function comparePrimary(a, b) {
  return (
    (a.status === "online" ? 0 : 1) - (b.status === "online" ? 0 : 1) ||
    (b.primary ? 1 : 0) - (a.primary ? 1 : 0) ||
    (TYPE_RANK[a.deviceType] ?? 0) - (TYPE_RANK[b.deviceType] ?? 0) ||
    (Date.parse(b.lastPing) || 0) - (Date.parse(a.lastPing) || 0) ||
    a.deviceId.localeCompare(b.deviceId)
  );
}

// One entry per person, the own account first, then by how alive their primary device is.
function groupByUser() {
  const groups = new Map();
  for (const device of devices) {
    if (!groups.has(device.userId)) groups.set(device.userId, { userId: device.userId, name: ownerName(device), devices: [] });
    groups.get(device.userId).devices.push(device);
  }
  for (const group of groups.values()) {
    group.devices.sort(comparePrimary);
    group.primary = group.devices[0];
  }
  return [...groups.values()].sort(
    (a, b) =>
      (isOwn(b.primary) ? 1 : 0) - (isOwn(a.primary) ? 1 : 0) ||
      STATE_ORDER[freshness(a.primary)] - STATE_ORDER[freshness(b.primary)] ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

const personAvatar = (group, size = "") => avatarHtml(group.primary, size, { label: group.name, colour: `user:${group.userId}` });
const openUsers = new Set();

// "iPhone · online" or "iPad · 5 min ago", with a hint when there are more devices.
function personMeta(group) {
  const device = group.primary;
  const state = freshness(device);
  const when = state === "online" ? "online" : state === "stale" ? "no recent position" : device.lastPing ? timeAgo(device.lastPing) : "offline";
  const more = group.devices.length - 1;
  return `${device.deviceId} · ${when}${more ? ` · +${more} ${more === 1 ? "device" : "devices"}` : ""}`;
}

// Your own devices, and as the admin everyone's.
const canPickPrimary = (device) => typeof me !== "undefined" && me !== null && (device.userId === me.id || me.isAdmin);

function starHtml(device) {
  const label = device.primary ? `${device.deviceId} is the main device, click for automatic` : `Make ${device.deviceId} the main device`;
  return `<button class="icon-btn subdevice__star${device.primary ? " is-on" : ""}" type="button" data-primary="${esc(keyOf(device))}" aria-pressed="${Boolean(device.primary)}" aria-label="${esc(label)}" title="${esc(label)}"><svg class="icon"><use href="#i-star" /></svg></button>`;
}

async function setPrimary(device, button) {
  const own = me && device.userId === me.id;
  const url = own ? "/api/me/primary-device" : `/api/users/${device.userId}/primary-device`;
  button.disabled = true;
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: device.primary ? null : device.deviceId }),
    });
    if (response.status === 401) return (window.location.href = "/login");
    // The new list arrives over the socket and redraws the panel.
    if (!response.ok) toast("The main device could not be changed.");
    else toast(device.primary ? "Main device: picked automatically" : `${device.deviceId} is the main device now`);
  } catch {
    toast("The server is not reachable.");
  } finally {
    button.disabled = false;
  }
}

function subDeviceHtml(device, pickable) {
  const selected = keyOf(device) === selectedId;
  const askable = device.status === "online";
  return `
    <li class="subdevice" data-state="${freshness(device)}">
      <button class="device device--sub${selected ? " is-selected" : ""}" type="button" data-id="${esc(keyOf(device))}"
        data-state="${freshness(device)}" data-located="${Boolean(device.position)}" aria-pressed="${selected}">
        ${typeIcon(device, " dtype--row")}
        <span class="device__text">
          <span class="device__name">${esc(device.deviceId)}</span>
          <span class="device__meta"><span class="device__meta-text">${esc(metaText(device))}</span>${batteryHtml(device)}</span>
        </span>
      </button>
      ${pickable ? starHtml(device) : ""}
      ${askable ? `<button class="icon-btn subdevice__ask" type="button" data-ask="${esc(keyOf(device))}" aria-label="Ask ${esc(device.deviceId)} for a fresh position" title="Ask for a fresh position"><svg class="icon"><use href="#i-refresh" /></svg></button>` : ""}
    </li>`;
}

function renderPanel() {
  const online = devices.filter((d) => d.status === "online").length;
  onlineCountEl.textContent = online;
  totalCountEl.textContent = devices.length;
  updateSummary();

  const groups = groupByUser();
  stackEl.innerHTML = groups
    .slice(0, 4)
    .map((group) => {
      return `<span class="stack-item">${personAvatar(group, "sm")}</span>`;
    })
    .join("");

  if (devices.length === 0) {
    const filtered = allDevices.length > 0;
    listEl.innerHTML = `
      <li class="empty">
        <span class="empty__icon"><svg class="icon"><use href="#i-phone" /></svg></span>
        <strong>${filtered ? "Nobody here yet" : "No devices yet"}</strong>
        ${filtered ? "No one in this group has shared a device." : "Sign in with the NeoPin app and the phone shows up here."}
      </li>`;
    return;
  }

  listEl.innerHTML = groups
    .map((group) => {
      const open = openUsers.has(group.userId);
      const holdsSelection = group.devices.some((d) => keyOf(d) === selectedId);
      const subs = open ? `<ul class="person__devices" role="list">${group.devices
        .map((device) => subDeviceHtml(device, group.devices.length > 1 && canPickPrimary(device)))
        .join("")}</ul>` : "";
      return `
        <li class="person${open ? " is-open" : ""}">
          <button class="device person__head${holdsSelection ? " is-selected" : ""}" type="button" data-user="${group.userId}"
            data-state="${freshness(group.primary)}" data-located="${Boolean(group.primary.position)}" aria-expanded="${open}">
            ${personAvatar(group)}
            <span class="device__text">
              <span class="device__name">${esc(group.name)}${isOwn(group.primary) ? ' <span class="own">you</span>' : ""}</span>
              <span class="device__meta">${typeIcon(group.primary)}<span class="device__meta-text">${esc(personMeta(group))}</span>${batteryHtml(group.primary)}</span>
            </span>
            <svg class="icon person__chevron" aria-hidden="true"><use href="#i-chevron" /></svg>
          </button>
          ${subs}
        </li>`;
    })
    .join("");
}

function render() {
  syncMarkers();
  renderPanel();
  syncPopup();
  document.documentElement.style.setProperty("--sheet-height", `${panel.offsetHeight + 16}px`);
}

// From the list the map zooms in on the device, from a pin it only moves enough
// to make room for the popup above it.
function select(id, { zoomIn = true, keepPanel = false } = {}) {
  selectedId = id;
  const device = devices.find((d) => keyOf(d) === id);
  if (phone.matches && id && !keepPanel) setExpanded(false);
  if (device && !device.position) toast(`${fullName(device)} has not sent a position yet.`);
  if (device?.position) {
    map.flyTo({
      center: [device.position.longitude, device.position.latitude],
      zoom: zoomIn ? Math.max(map.getZoom(), 15) : map.getZoom(),
      padding: { ...mapPadding(), top: 300 },
      duration: zoomIn ? 1000 : 500,
    });
  }
  render();
}

listEl.addEventListener("click", (event) => {
  const star = event.target.closest("[data-primary]");
  if (star) {
    const device = devices.find((d) => keyOf(d) === star.dataset.primary);
    if (device) setPrimary(device, star);
    return;
  }
  const ask = event.target.closest("[data-ask]");
  if (ask) {
    const device = devices.find((d) => keyOf(d) === ask.dataset.ask);
    if (device) pingDevice(device, ask);
    return;
  }
  const row = event.target.closest("[data-id]");
  if (row) return select(row.dataset.id);
  const head = event.target.closest("[data-user]");
  if (!head) return;
  // A first click focuses the person's primary device and opens the list, a second one folds it.
  const userId = Number(head.dataset.user);
  if (openUsers.delete(userId)) return render();
  openUsers.add(userId);
  const primary = groupByUser().find((g) => g.userId === userId)?.primary;
  select(primary ? keyOf(primary) : null, { keepPanel: true });
});

function setExpanded(expanded) {
  panel.dataset.expanded = String(expanded);
  panelToggle.setAttribute("aria-expanded", String(expanded));
  document.documentElement.style.setProperty("--sheet-height", `${panel.offsetHeight + 16}px`);
}

panelToggle.addEventListener("click", () => setExpanded(panel.dataset.expanded !== "true"));

refreshButton.addEventListener("click", () => {
  if (socket?.readyState !== WebSocket.OPEN) return toast("Not connected to the server.");
  socket.send(JSON.stringify({ type: "pingDevices" }));
  refreshButton.classList.add("is-busy");
  refreshButton.disabled = true;
  setTimeout(() => {
    refreshButton.classList.remove("is-busy");
    refreshButton.disabled = false;
  }, 2000);
});

// Live data

function filterDevices() {
  return groupFilter === null ? allDevices : allDevices.filter((d) => d.groupIds?.includes(groupFilter));
}

function setGroupFilter(id) {
  groupFilter = id;
  try {
    if (typeof me !== "undefined" && me) localStorage.setItem(`neopin.group.${me.id}`, id === null ? "all" : String(id));
  } catch {
    // storage can be blocked, the filter just does not stick
  }
  devices = filterDevices();
  if (selectedId && !devices.some((d) => keyOf(d) === selectedId)) selectedId = null;
  render();
  if (located().length > 0) fitAll(true);
  if (typeof renderChips === "function") renderChips();
}

function receive(list) {
  allDevices = list;
  devices = filterDevices();
  if (selectedId && !devices.some((d) => keyOf(d) === selectedId)) selectedId = null;
  render();
  if (!fittedOnce && located().length > 0 && !document.body.classList.contains("is-timeline")) {
    fittedOnce = true;
    fitAll(false);
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  setStatus("connecting");
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}`);

  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "authenticate", viewer: true })));
  socket.addEventListener("message", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if ("successful" in data) {
      if (!data.successful) return (window.location.href = "/login");
      setStatus("online");
      hideLoader();
      return;
    }
    if (data.type === "dataResponse") receive(data.devices || []);
    // Groups, invites or members changed: the devices in view may change with them.
    if (data.type === "groupsChanged") {
      socket.send(JSON.stringify({ type: "getData" }));
      document.dispatchEvent(new Event("groupschanged"));
    }
  });
  socket.addEventListener("close", (event) => {
    if (event.code === 4000) {
      // Also sent when the password changes elsewhere or here. A valid session just reconnects.
      fetch("/api/me")
        .then((response) => {
          if (response.ok) reconnectTimer = setTimeout(connect, 500);
          else window.location.href = "/login";
        })
        .catch(() => (reconnectTimer = setTimeout(connect, 3000)));
      return;
    }
    setStatus("offline");
    hideLoader();
    reconnectTimer = setTimeout(connect, 3000);
  });
  socket.addEventListener("error", () => socket.close());
}

// Times like "3 min ago" and the stale state move on without new data.
setInterval(render, 15_000);
// On a phone the list starts folded, so the map stays visible.
phone.addEventListener("change", (event) => setExpanded(!event.matches));
setExpanded(!phone.matches);
render();
connect();

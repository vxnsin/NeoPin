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
const clockEl = document.getElementById("clock");
const dateEl = document.getElementById("date");
const listEl = document.getElementById("deviceList");
const stackEl = document.getElementById("avatarStack");
const panel = document.getElementById("devicesPanel");
const panelToggle = document.getElementById("panelToggle");
const refreshButton = document.getElementById("refreshButton");
const toastEl = document.getElementById("toast");
const mapEl = document.getElementById("map");
const phone = window.matchMedia("(max-width: 767px)");

const markers = new Map();
let devices = [];
let selectedId = null;
let socket = null;
let reconnectTimer = null;
let fittedOnce = false;
let toastTimer = null;

// Device names come from the phones, never put them into HTML unescaped.
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
function avatarHtml(device, size = "") {
  const inner = device.avatarUrl
    ? `<img src="${esc(device.avatarUrl)}" alt="" decoding="async" />`
    : `<span>${esc(initials(device.deviceId))}</span>`;
  const sizeClass = size ? ` avatar--${size}` : "";
  return `<span class="avatar${sizeClass} ${colourClass(device.deviceId)}" data-state="${freshness(device)}">${inner}</span>`;
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

function updateClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// Map

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLES[window.neopinTheme.get()],
  center: [10.45, 51.16],
  zoom: 5,
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
});
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
updateLabels();

document.documentElement.addEventListener("themechange", (event) => {
  // Markers are DOM elements and survive the style swap.
  map.setStyle(MAP_STYLES[event.detail]);
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
  map.fitBounds(bounds, { padding, maxZoom: 15, duration });
}

function pinHtml(device) {
  return `<span class="pin__body"><span class="pin__bubble">${avatarHtml(device)}</span><span class="pin__label">${esc(device.deviceId)}</span></span>`;
}

function syncMarkers() {
  const seen = new Set();
  for (const device of located()) {
    const id = device.deviceId;
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
    const key = `${state}|${device.avatarUrl}`;
    if (entry.key !== key) {
      entry.el.innerHTML = pinHtml(device);
      entry.el.dataset.state = state;
      entry.el.setAttribute("aria-label", `${device.deviceId}, ${STATE_LABELS[state]}`);
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
          <strong class="popup__name">${esc(device.deviceId)}</strong>
          <span class="popup__state">${esc(STATE_LABELS[state])} · ${esc(timeAgo(device.lastPing))}</span>
        </div>
      </div>
      <p class="popup__coords">${coords}</p>
      ${state === "offline" ? "" : '<button class="btn btn--small btn--ghost" type="button" data-ping>Ask for a fresh position</button>'}
    </div>`;
}

function syncPopup() {
  const device = devices.find((d) => d.deviceId === selectedId);
  if (!device?.position) {
    if (popup.isOpen()) popup.remove();
    return;
  }
  popup.setLngLat([device.position.longitude, device.position.latitude]).setHTML(popupHtml(device));
  if (!popup.isOpen()) popup.addTo(map);
  popup.getElement().querySelector("[data-ping]")?.addEventListener("click", (event) => pingDevice(device.deviceId, event.currentTarget));
}

async function pingDevice(deviceId, button) {
  button.disabled = true;
  button.textContent = "Asking…";
  try {
    const response = await fetch("/api/sendPing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
    if (response.status === 401) return (window.location.href = "/login.html");
    if (!response.ok) toast("The device is not connected right now.");
  } catch {
    toast("The server is not reachable.");
  }
  // The answer arrives over the socket and redraws the popup.
  if (button.isConnected) {
    button.disabled = false;
    button.textContent = "Ask for a fresh position";
  }
}

// Device panel

function sortedDevices() {
  return [...devices].sort(
    (a, b) =>
      STATE_ORDER[freshness(a)] - STATE_ORDER[freshness(b)] ||
      a.deviceId.localeCompare(b.deviceId, undefined, { sensitivity: "base" })
  );
}

function renderPanel() {
  const online = devices.filter((d) => d.status === "online").length;
  onlineCountEl.textContent = online;
  totalCountEl.textContent = devices.length;
  updateSummary();

  const sorted = sortedDevices();
  stackEl.innerHTML = sorted.slice(0, 4).map((device) => avatarHtml(device, "sm")).join("");

  if (devices.length === 0) {
    listEl.innerHTML = `
      <li class="empty">
        <span class="empty__icon"><svg class="icon"><use href="#i-phone" /></svg></span>
        <strong>No devices yet</strong>
        Sign in with the NeoPin app and the phone shows up here.
      </li>`;
    return;
  }

  listEl.innerHTML = sorted
    .map((device) => {
      const selected = device.deviceId === selectedId;
      return `
        <li>
          <button class="device${selected ? " is-selected" : ""}" type="button" data-id="${esc(device.deviceId)}"
            data-state="${freshness(device)}" data-located="${Boolean(device.position)}" aria-pressed="${selected}">
            ${avatarHtml(device)}
            <span class="device__text">
              <span class="device__name">${esc(device.deviceId)}</span>
              <span class="device__meta">${esc(metaText(device))}</span>
            </span>
            <svg class="icon device__go" aria-hidden="true"><use href="#i-locate" /></svg>
          </button>
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
function select(id, { zoomIn = true } = {}) {
  selectedId = id;
  const device = devices.find((d) => d.deviceId === id);
  if (phone.matches && id) setExpanded(false);
  if (device && !device.position) toast(`${device.deviceId} has not sent a position yet.`);
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
  const button = event.target.closest("[data-id]");
  if (button) select(button.dataset.id);
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

function receive(list) {
  devices = list;
  if (selectedId && !devices.some((d) => d.deviceId === selectedId)) selectedId = null;
  render();
  if (!fittedOnce && located().length > 0) {
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
      if (!data.successful) return (window.location.href = "/login.html");
      setStatus("online");
      hideLoader();
      return;
    }
    if (data.type === "dataResponse") receive(data.devices || []);
  });
  socket.addEventListener("close", (event) => {
    if (event.code === 4000) {
      window.location.href = "/login.html";
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
setInterval(updateClock, 5_000);
// On a phone the list starts folded, so the map stays visible.
phone.addEventListener("change", (event) => setExpanded(!event.matches));
setExpanded(!phone.matches);
updateClock();
render();
connect();

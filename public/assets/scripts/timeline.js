// Day view of one device's history: a list of stays and trips next to the same day on the map.
const MODES = {
  walking: { label: "Walking", icon: "#i-walk", color: "#16a34a" },
  cycling: { label: "Cycling", icon: "#i-bike", color: "#2563eb" },
  driving: { label: "Driving", icon: "#i-car", color: "#ea580c" },
};
const TL_SOURCE = "timeline";
const KIND_LABELS = {
  home: "Home",
  work: "Work",
  cafe: "Café",
  restaurant: "Restaurant",
  bar: "Bar",
  grocery: "Groceries",
  shop: "Shop",
  station: "Station",
  school: "School",
  health: "Health",
  sport: "Sport",
  park: "Park",
  culture: "Culture",
  hotel: "Hotel",
  worship: "Place of worship",
  fuel: "Fuel",
  building: "Building",
  place: "Place",
};
// Place names that are still looked up are asked for again, a few times at most.
const PENDING_RETRY_MS = 4000;
const PENDING_RETRIES = 5;

const tlButton = document.getElementById("timelineButton");
const tlPanel = document.getElementById("timelinePanel");
const tlClose = document.getElementById("timelineClose");
const tlAccount = document.getElementById("tlAccount");
const tlDevice = document.getElementById("tlDevice");
const tlDate = document.getElementById("tlDate");
const tlPrev = document.getElementById("tlPrev");
const tlNext = document.getElementById("tlNext");
const tlBody = document.getElementById("tlBody");

const tl = { on: false, userId: null, deviceId: null, date: null, days: [], data: null, active: null, loadId: 0, markers: [], retries: 0 };

function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// An admin looking at somebody else's account adds that account's id.
const userQuery = () => (tl.userId && tl.userId !== me?.id ? `userId=${tl.userId}` : "");
const tzQuery = () => [`tz=${new Date().getTimezoneOffset()}`, userQuery()].filter(Boolean).join("&");
const withUser = (path) => (userQuery() ? `${path}${path.includes("?") ? "&" : "?"}${userQuery()}` : path);

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function formatDistance(meters) {
  if (meters < 950) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

async function getJson(url) {
  const response = await fetch(url);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("signed-out");
  }
  if (!response.ok) throw new Error("failed");
  return response.json();
}

async function sendJson(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("signed-out");
  }
  if (!response.ok) throw new Error("failed");
  return response.json();
}

// Map

function emptyLines() {
  return { type: "FeatureCollection", features: [] };
}

function linesData() {
  const features = (tl.data?.segments ?? []).flatMap((segment, index) =>
    segment.type === "trip" && segment.path.length > 1
      ? [
          {
            type: "Feature",
            properties: { index, color: MODES[segment.mode]?.color ?? "#64748b", active: index === tl.active },
            geometry: { type: "LineString", coordinates: segment.path.map(([lat, lon]) => [lon, lat]) },
          },
        ]
      : []
  );
  return { type: "FeatureCollection", features };
}

// A new map style drops sources and layers, so this runs again after every style load.
function ensureLayers() {
  if (!map.getStyle()) return;
  if (!map.getSource(TL_SOURCE)) {
    map.addSource(TL_SOURCE, { type: "geojson", data: emptyLines() });
    map.addLayer({
      id: "tl-casing",
      type: "line",
      source: TL_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-opacity": 0.9, "line-width": ["case", ["get", "active"], 9, 6] },
    });
    map.addLayer({
      id: "tl-line",
      type: "line",
      source: TL_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "active"], 6, 3.5] },
    });
  }
  map.getSource(TL_SOURCE).setData(tl.on ? linesData() : emptyLines());
}

map.on("style.load", ensureLayers);
map.on("mouseenter", "tl-line", () => (map.getCanvas().style.cursor = "pointer"));
map.on("mouseleave", "tl-line", () => (map.getCanvas().style.cursor = ""));
map.on("click", "tl-line", (event) => {
  const index = event.features?.[0]?.properties?.index;
  if (index !== undefined) focusSegment(Number(index), { scroll: true });
});

function clearMarkers() {
  for (const marker of tl.markers) marker.remove();
  tl.markers = [];
}

function drawMarkers() {
  clearMarkers();
  let number = 0;
  (tl.data?.segments ?? []).forEach((segment, index) => {
    if (segment.type !== "visit") return;
    number += 1;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tl-marker";
    el.textContent = String(number);
    el.dataset.index = String(index);
    el.setAttribute("aria-label", `${segment.place?.name ?? `Stop ${number}`}, ${formatTime(segment.start)}`);
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      focusSegment(index, { scroll: true });
    });
    tl.markers.push(new maplibregl.Marker({ element: el }).setLngLat([segment.lon, segment.lat]).addTo(map));
  });
}

function timelinePadding() {
  const box = tlPanel.getBoundingClientRect();
  if (phone.matches) return { top: 100, bottom: window.innerHeight - box.top + 50, left: 50, right: 50 };
  return { top: 120, bottom: 80, left: box.right + 70, right: 110 };
}

function fitDay() {
  const points = [];
  for (const segment of tl.data?.segments ?? []) {
    if (segment.type === "visit") points.push([segment.lon, segment.lat]);
    else for (const [lat, lon] of segment.path) points.push([lon, lat]);
  }
  if (points.length === 0) return;
  const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
  fitBoundsTo(bounds, timelinePadding(), 800);
}

function markActive(index) {
  tl.active = index;
  tlBody.querySelectorAll(".seg").forEach((el) => el.classList.toggle("is-active", Number(el.dataset.index) === index));
  for (const marker of tl.markers) {
    const el = marker.getElement();
    el.classList.toggle("is-active", Number(el.dataset.index) === index);
  }
  map.getSource(TL_SOURCE)?.setData(linesData());
}

function focusSegment(index, { scroll = false } = {}) {
  const segment = tl.data?.segments[index];
  if (!segment) return;
  markActive(index);

  if (phone.matches) setSheetOpen(false);
  const padding = timelinePadding();
  if (segment.type === "visit") {
    map.flyTo({ center: [segment.lon, segment.lat], zoom: Math.max(map.getZoom(), 15), padding, duration: 800 });
  } else if (segment.path.length > 0) {
    const first = [segment.path[0][1], segment.path[0][0]];
    const bounds = segment.path.reduce((b, [lat, lon]) => b.extend([lon, lat]), new maplibregl.LngLatBounds(first, first));
    fitBoundsTo(bounds, timelinePadding(), 800);
  }
  if (scroll) tlBody.querySelector(`.seg[data-index="${index}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Panel

function renderSummary(summary) {
  return `
    <div class="tl-summary">
      <div><strong>${esc(formatDistance(summary.distanceM))}</strong><span>distance</span></div>
      <div><strong>${esc(summary.movingMs ? formatDuration(summary.movingMs) : "0 min")}</strong><span>moving</span></div>
      <div><strong>${summary.visits}</strong><span>${summary.visits === 1 ? "stop" : "stops"}</span></div>
    </div>`;
}

function renderSegments(segments) {
  let number = 0;
  const items = segments.map((segment, index) => {
    const times = `${formatTime(segment.start)} – ${formatTime(segment.end)}`;
    if (segment.type === "visit") {
      number += 1;
      const place = segment.place;
      // A guess from OpenStreetMap says so until someone confirms it.
      const about = place
        ? `<span class="seg__meta">${esc(KIND_LABELS[place.kind] ?? "Place")}${place.source === "osm" ? " · suggested" : ""}</span>`
        : `<span class="seg__meta seg__coords">${segment.lat.toFixed(4)}, ${segment.lon.toFixed(4)}</span>`;
      return `
        <li class="seg-item">
          <button class="seg seg--visit" type="button" data-index="${index}">
            <span class="seg__badge">${number}</span>
            <span class="seg__text">
              <span class="seg__title">${esc(place?.name ?? `Stop ${number}`)}</span>
              <span class="seg__meta">${esc(times)} · ${esc(formatDuration(segment.durationMs))}</span>
              ${about}
            </span>
          </button>
          <button class="seg__edit" type="button" data-edit="${index}" aria-label="Change the place" title="Change the place">
            <svg class="icon"><use href="#i-edit" /></svg>
          </button>
          <div class="place-picker" data-picker="${index}" hidden></div>
        </li>`;
    }
    const mode = MODES[segment.mode] ?? MODES.walking;
    return `
      <li>
        <button class="seg seg--trip" type="button" data-index="${index}" data-mode="${esc(segment.mode)}">
          <span class="seg__badge seg__badge--trip"><svg class="icon"><use href="${mode.icon}" /></svg></span>
          <span class="seg__text">
            <span class="seg__title">${esc(mode.label)} · ${esc(formatDistance(segment.distanceM))}</span>
            <span class="seg__meta">${esc(times)} · ${esc(formatDuration(segment.durationMs))}</span>
          </span>
        </button>
      </li>`;
  });
  return `<ol class="seg-list">${items.join("")}</ol>`;
}

function renderBody(state) {
  if (state === "loading") tlBody.innerHTML = '<div class="tl-note"><div class="spinner"></div></div>';
  else if (state === "error")
    tlBody.innerHTML = '<div class="tl-note"><strong>Could not load this day</strong>Check the connection and pick the day again.</div>';
  else if (state === "nodevice")
    tlBody.innerHTML =
      '<div class="tl-note"><span class="empty__icon"><svg class="icon"><use href="#i-phone" /></svg></span><strong>No devices yet</strong>Sign in with the NeoPin app and its history shows up here.</div>';
  else if (!tl.data || tl.data.segments.length === 0)
    tlBody.innerHTML =
      '<div class="tl-note"><span class="empty__icon"><svg class="icon"><use href="#i-place" /></svg></span><strong>Nothing recorded</strong>This device did not report any positions on this day.</div>';
  else tlBody.innerHTML = renderSummary(tl.data.summary) + renderSegments(tl.data.segments);
}

function updateNav() {
  const prev = tl.days.find((day) => day < tl.date);
  const next = [...tl.days].reverse().find((day) => day > tl.date);
  tlPrev.disabled = !prev;
  tlNext.disabled = !next;
  tlPrev.dataset.day = prev ?? "";
  tlNext.dataset.day = next ?? "";
}

// keepView reloads the same day in place (new place names), the map and the list stay where they are.
async function loadDay({ keepView = false } = {}) {
  const id = ++tl.loadId;
  const active = keepView ? tl.active : null;
  const scroll = tlBody.scrollTop;
  if (!keepView) {
    tl.data = null;
    tl.active = null;
    tl.retries = 0;
    clearMarkers();
    ensureLayers();
    updateNav();
    if (!tl.deviceId) return renderBody("nodevice");
    renderBody("loading");
  }
  try {
    const data = await getJson(`/api/timeline?deviceId=${encodeURIComponent(tl.deviceId)}&date=${tl.date}&${tzQuery()}`);
    if (id !== tl.loadId) return;
    tl.data = data;
    renderBody("ready");
    ensureLayers();
    drawMarkers();
    if (keepView) {
      tlBody.scrollTop = scroll;
      if (active !== null) markActive(active);
    } else fitDay();
    if (data.placesPending && tl.retries < PENDING_RETRIES) {
      tl.retries += 1;
      setTimeout(() => id === tl.loadId && tl.on && loadDay({ keepView: true }), PENDING_RETRY_MS);
    }
  } catch (error) {
    if (id === tl.loadId && error.message !== "signed-out" && !keepView) renderBody("error");
  }
}

// Places

async function openPicker(index) {
  const segment = tl.data?.segments[index];
  const picker = tlBody.querySelector(`.place-picker[data-picker="${index}"]`);
  if (!segment || !picker) return;
  const open = picker.hidden;
  tlBody.querySelectorAll(".place-picker").forEach((el) => (el.hidden = true));
  if (!open) return;
  picker.hidden = false;
  picker.innerHTML = '<div class="place-picker__note"><div class="spinner"></div></div>';
  let choices = [];
  try {
    choices = await getJson(withUser(`/api/places/nearby?lat=${segment.lat}&lon=${segment.lon}`));
  } catch (error) {
    if (error.message === "signed-out") return;
  }
  const current = segment.place;
  const confirm =
    current?.source === "osm"
      ? `<button class="place-choice place-choice--confirm" type="button" data-confirm>
          <span>Yes, I was at ${esc(current.name)}</span><small>Confirm the suggestion</small>
        </button>`
      : "";
  const list =
    choices
      .map(
        (c, i) => `<button class="place-choice${current && c.name === current.name ? " is-current" : ""}" type="button" data-choice="${i}">
          <span>${esc(c.name)}</span>
          <small>${esc(KIND_LABELS[c.kind] ?? "Place")} · ${esc(formatDistance(c.distanceM))}${c.source === "own" ? " · yours" : ""}</small>
        </button>`
      )
      .join("") || '<div class="place-picker__note">Nothing named close by.</div>';
  picker.innerHTML = `
    ${confirm}
    <div class="place-picker__list">${list}</div>
    <form class="place-picker__own">
      <input name="name" maxlength="80" placeholder="Name it yourself" required autocomplete="off" />
      <select name="kind" aria-label="Kind of place">
        <option value="place">Place</option>
        <option value="home">Home</option>
        <option value="work">Work</option>
      </select>
      <button class="place-picker__save" type="submit">Save</button>
    </form>
    <div class="place-picker__error" hidden>Could not save, try again.</div>`;
  picker.dataset.choices = JSON.stringify(choices);
}

// Saving names the spot of the visit. A nearby own place that did not reach this far grows to cover it.
async function savePlace(index, choice) {
  const segment = tl.data?.segments[index];
  const picker = tlBody.querySelector(`.place-picker[data-picker="${index}"]`);
  if (!segment || !picker || !choice) return;
  picker.querySelectorAll("button, input, select").forEach((el) => (el.disabled = true));
  try {
    if (choice.source === "own" && choice.id) {
      await sendJson(withUser(`/api/places/${choice.id}`), "PATCH", { radiusM: Math.min(1000, Math.round(choice.distanceM + 25)) });
    } else {
      await sendJson(withUser("/api/places"), "POST", {
        lat: segment.lat,
        lon: segment.lon,
        name: choice.name,
        kind: choice.kind,
        ...(choice.osmId && { osmId: choice.osmId }),
      });
    }
    await loadDay({ keepView: true });
  } catch (error) {
    if (error.message === "signed-out") return;
    picker.querySelectorAll("button, input, select").forEach((el) => (el.disabled = false));
    picker.querySelector(".place-picker__error").hidden = false;
  }
}

function setDay(day) {
  tl.date = day;
  tlDate.value = day;
  loadDay();
}

async function loadDays({ pickLatest = false } = {}) {
  tl.days = [];
  if (tl.deviceId) {
    try {
      tl.days = await getJson(`/api/timeline/days?deviceId=${encodeURIComponent(tl.deviceId)}&${tzQuery()}`);
    } catch {
      tl.days = [];
    }
  }
  setDay(pickLatest && tl.days.length > 0 ? tl.days[0] : (tl.date ?? localDay()));
}

// Every device linked to the account, also those that are offline right now.
async function loadDevices() {
  const own = !tl.userId || tl.userId === me?.id;
  let ids = [];
  try {
    const list = await getJson(own ? "/api/devices" : `/api/users/${tl.userId}/devices`);
    ids = list.map((d) => d.deviceId).sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
  } catch {
    ids = [];
  }
  tlDevice.replaceChildren(
    ...ids.map((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      return option;
    })
  );
  tlDevice.disabled = ids.length === 0;
  if (!ids.includes(tl.deviceId)) tl.deviceId = ids[0] ?? null;
  if (tl.deviceId) tlDevice.value = tl.deviceId;
}

// Only the admin may look at other accounts, everybody else sees just their own devices.
async function loadAccounts() {
  tlAccount.hidden = !me?.isAdmin;
  if (!me?.isAdmin) return;
  let users = [];
  try {
    users = await getJson("/api/users");
  } catch {
    users = [me];
  }
  tlAccount.replaceChildren(
    ...users.map((user) => {
      const option = document.createElement("option");
      option.value = String(user.id);
      option.textContent = user.id === me.id ? `${user.displayName || user.username} (you)` : user.displayName || user.username;
      return option;
    })
  );
  if (!users.some((u) => u.id === tl.userId)) tl.userId = me.id;
  tlAccount.value = String(tl.userId);
}

// On a phone the sheet folds away while a segment is focused, so the map is visible.
function setSheetOpen(open) {
  tlPanel.dataset.open = String(open);
  document.documentElement.style.setProperty("--sheet-height", `${tlPanel.offsetHeight + 16}px`);
}

function setTimelineMode(on) {
  if (tl.on === on) return;
  tl.on = on;
  document.body.classList.toggle("is-timeline", on);
  tlPanel.hidden = !on;
  tlButton.setAttribute("aria-pressed", String(on));
  tlButton.setAttribute("aria-label", on ? "Back to the live view" : "Show the timeline");
  if (on) {
    select(null);
    tlDate.max = localDay();
    renderBody("loading");
    setSheetOpen(true);
    const id = ++tl.loadId;
    tl.userId ??= me?.id ?? null;
    meReady
      .then(loadAccounts)
      .then(loadDevices)
      .then(() => {
        if (id === tl.loadId && tl.on) loadDays({ pickLatest: !tl.date || tl.date === localDay() });
      });
  } else {
    tl.loadId += 1;
    clearMarkers();
    ensureLayers();
    document.documentElement.style.setProperty("--sheet-height", `${panel.offsetHeight + 16}px`);
    fitAll(false);
  }
}

tlButton.addEventListener("click", () => setTimelineMode(!tl.on));
tlClose.addEventListener("click", () => setTimelineMode(false));

tlAccount.addEventListener("change", async () => {
  tl.userId = Number(tlAccount.value);
  tl.deviceId = null;
  await loadDevices();
  loadDays({ pickLatest: true });
});
tlDevice.addEventListener("change", () => {
  tl.deviceId = tlDevice.value;
  loadDays({ pickLatest: true });
});
tlDate.addEventListener("change", () => {
  if (tlDate.value) setDay(tlDate.value);
});
tlPrev.addEventListener("click", () => tlPrev.dataset.day && setDay(tlPrev.dataset.day));
tlNext.addEventListener("click", () => tlNext.dataset.day && setDay(tlNext.dataset.day));

tlBody.addEventListener("click", (event) => {
  const edit = event.target.closest(".seg__edit");
  if (edit) return openPicker(Number(edit.dataset.edit));
  const picker = event.target.closest(".place-picker");
  if (picker) {
    const index = Number(picker.dataset.picker);
    const pick = event.target.closest("[data-choice]");
    if (pick) savePlace(index, JSON.parse(picker.dataset.choices ?? "[]")[Number(pick.dataset.choice)]);
    if (event.target.closest("[data-confirm]")) {
      const { name, kind, osmId } = tl.data.segments[index].place;
      savePlace(index, { name, kind, osmId, source: "osm" });
    }
    return;
  }
  const seg = event.target.closest(".seg");
  if (seg) focusSegment(Number(seg.dataset.index));
});

tlBody.addEventListener("submit", (event) => {
  const form = event.target.closest(".place-picker__own");
  if (!form) return;
  event.preventDefault();
  const name = form.elements.name.value.trim();
  if (!name) return;
  savePlace(Number(form.closest(".place-picker").dataset.picker), { name, kind: form.elements.kind.value, source: "typed" });
});

// On a phone a tap on the head folds the sheet or brings the list back.
tlPanel.querySelector(".timeline__head").addEventListener("click", (event) => {
  if (phone.matches && !event.target.closest("button")) setSheetOpen(tlPanel.dataset.open !== "true");
});

// Day view of one device's history: a list of stays and trips next to the same day on the map.
// How a trip looks (modes, lines, colours) comes from trips.js.
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
// Saved with one click, the server picks the name ("Home", "Home 2", "Work").
const QUICK_KINDS = ["home", "work"];
// Place names that are still looked up, and paths that are still smoothed, are asked for
// again, a few times at most.
const PENDING_RETRY_MS = 4000;
const PENDING_RETRIES = 5;

const tlButton = document.getElementById("timelineButton");
const tlPanel = document.getElementById("timelinePanel");
const tlClose = document.getElementById("timelineClose");
const tlReload = document.getElementById("timelineReload");
const tlAccount = document.getElementById("tlAccount");
const tlDevice = document.getElementById("tlDevice");
const tlDate = document.getElementById("tlDate");
const tlPrev = document.getElementById("tlPrev");
const tlNext = document.getElementById("tlNext");
const tlBody = document.getElementById("tlBody");

const tl = { on: false, userId: null, deviceId: null, date: null, days: [], data: null, active: null, loadId: 0, markers: [], retries: 0 };
// Whose timelines this account may read, from the server: itself first, then whoever shares
// theirs with it (the admin reads all), each with the devices to pick from.
let tlPeople = [];

// Somebody else's day is for reading only. The admin may still name places and correct trips.
const readOnly = () => !!tl.userId && tl.userId !== me?.id && !me?.isAdmin;

function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Looking at somebody else's timeline adds that account's id.
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

// Corrections answer 204 without a body.
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
  return response.status === 204 ? null : response.json();
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
            properties: {
              index,
              color: tripColor(segment),
              active: index === tl.active,
              gap: !!segment.gap,
            },
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
    // Stretches without fixes: only start and end are known, so a thin dashed line.
    map.addLayer({
      id: "tl-gap",
      type: "line",
      source: TL_SOURCE,
      filter: ["get", "gap"],
      layout: { "line-cap": "round" },
      paint: { "line-color": GAP_COLOR, "line-width": ["case", ["get", "active"], 3.5, 2.5], "line-dasharray": [1.5, 2.5] },
    });
    map.addLayer({
      id: "tl-casing",
      type: "line",
      source: TL_SOURCE,
      filter: ["!", ["get", "gap"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-opacity": 0.9, "line-width": ["case", ["get", "active"], 9, 6] },
    });
    map.addLayer({
      id: "tl-line",
      type: "line",
      source: TL_SOURCE,
      filter: ["!", ["get", "gap"]],
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

function addMarker(el, index, lngLat) {
  el.type = "button";
  el.dataset.index = String(index);
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    focusSegment(index, { scroll: true });
  });
  tl.markers.push(new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map));
}

function drawMarkers() {
  clearMarkers();
  const segments = tl.data?.segments ?? [];
  // Where a ride was boarded and left: a small dot in the line's colour, under the numbered stops.
  segments.forEach((segment, index) => {
    const transit = segment.type === "trip" ? segment.transit : null;
    if (!transit) return;
    for (const [stop, role] of [[transit.from, "boarded"], [transit.to, "left"]]) {
      const el = document.createElement("button");
      el.className = "tl-tstop";
      el.style.setProperty("--line", tripColor(segment));
      el.setAttribute("aria-label", `${stop.name}, where the ride was ${role}`);
      addMarker(el, index, [stop.lon, stop.lat]);
    }
  });
  let number = 0;
  segments.forEach((segment, index) => {
    if (segment.type !== "visit") return;
    number += 1;
    const el = document.createElement("button");
    el.className = "tl-marker";
    el.textContent = String(number);
    el.setAttribute("aria-label", `${segment.place?.name ?? `Stop ${number}`}, ${formatTime(segment.start)}`);
    addMarker(el, index, [segment.lon, segment.lat]);
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

// Whether all these points are on screen, outside the panel and the edges.
function inView(points, padding) {
  const canvas = map.getCanvas().getBoundingClientRect();
  return points.every(([lon, lat]) => {
    const p = map.project([lon, lat]);
    return p.x >= padding.left && p.x <= canvas.width - padding.right && p.y >= padding.top && p.y <= canvas.height - padding.bottom;
  });
}

// fold: on a phone the sheet folds away so the map is visible, unless a chooser just opened in it.
function focusSegment(index, { scroll = false, fold = true } = {}) {
  const segment = tl.data?.segments[index];
  if (!segment) return;
  markActive(index);

  if (phone.matches && fold) setSheetOpen(false);
  const padding = timelinePadding();
  const points = segment.type === "visit" ? [[segment.lon, segment.lat]] : segment.path.map(([lat, lon]) => [lon, lat]);
  if (points.length && !inView(points, padding)) {
    if (points.length === 1) map.easeTo({ center: points[0], padding, duration: 600 });
    else {
      const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
      fitBoundsTo(bounds, padding, 600, Math.max(map.getZoom(), 12));
    }
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

// "10" on the line's own colours; lines without colours get a quiet badge.
function lineBadge(transit) {
  if (!transit.line) return "";
  const { bg, fg } = badgeColors(transit);
  const style = [bg && `background:${bg};border-color:${bg}`, fg && `color:${fg}`].filter(Boolean).join(";");
  return `<span class="line-badge"${style ? ` style="${style}"` : ""}>${esc(transit.line)}</span>`;
}

function tripHtml(segment, index, times) {
  const duration = formatDuration(segment.durationMs);
  const transit = segment.transit;
  let title;
  if (segment.gap) title = `<span class="seg__title">No data · ${esc(formatDistance(segment.distanceM))}</span>`;
  // "10" · "Bus · Sanderring → Hauptbahnhof"
  else if (transit) {
    title = `<span class="seg__title seg__ride">${lineBadge(transit)}<span class="seg__ride-text">${esc(rideLabel(transit))} · ${esc(transit.from.name)} → ${esc(transit.to.name)}</span></span>`;
  } else {
    const mode = MODES[segment.mode] ?? MODES.walking;
    title = `<span class="seg__title">${esc(mode.label)} · ${esc(formatDistance(segment.distanceM))}</span>`;
  }
  return `
    <li>
      <button class="seg seg--trip" type="button" data-index="${index}" style="--mode:${tripColor(segment)}" aria-expanded="false">
        <span class="seg__badge seg__badge--trip"><svg class="icon"><use href="${tripIcon(segment)}" /></svg></span>
        <span class="seg__text">
          ${title}
          <span class="seg__meta">${esc(times)} · ${esc(duration)}</span>
        </span>
      </button>
      <div class="mode-chooser" data-chooser="${index}" hidden></div>
    </li>`;
}

function renderSegments(segments) {
  let number = 0;
  const items = segments.map((segment, index) => {
    const times = `${formatTime(segment.start)} – ${formatTime(segment.end)}`;
    if (segment.type !== "visit") return tripHtml(segment, index, times);
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
        ${
          readOnly()
            ? ""
            : `<button class="seg__edit" type="button" data-edit="${index}" aria-label="Change the place" title="Change the place">
          <svg class="icon"><use href="#i-edit" /></svg>
        </button>
        <div class="place-picker" data-picker="${index}" hidden></div>`
        }
      </li>`;
  });
  return `<ol class="seg-list">${items.join("")}</ol>`;
}

// What was removed stays in reach: each removed stop of the day, with a way back.
function renderRemoved(spans) {
  if (!spans?.length || readOnly()) return "";
  const rows = spans
    .map((span, i) => {
      const times = `${formatTime(span.start)} – ${formatTime(span.end)}`;
      return `
        <li class="tl-removed__row">
          <span>${esc(times)}</span>
          <button class="btn btn--small btn--ghost" type="button" data-restore="${i}" aria-label="${esc(`Bring back the stop from ${times}`)}">
            <svg class="icon"><use href="#i-undo" /></svg>Bring back
          </button>
        </li>`;
    })
    .join("");
  return `<div class="tl-removed"><strong class="tl-removed__title">Removed stops</strong><ul class="tl-removed__list">${rows}</ul></div>`;
}

function renderBody(state) {
  if (state === "loading") tlBody.innerHTML = '<div class="tl-note"><div class="spinner"></div></div>';
  else if (state === "error")
    tlBody.innerHTML =
      '<div class="tl-note"><strong>Could not load this day</strong>Check the connection and try again.<button class="btn btn--small btn--ghost" type="button" data-retry>Try again</button></div>';
  else if (state === "nodevice")
    tlBody.innerHTML =
      '<div class="tl-note"><span class="empty__icon"><svg class="icon"><use href="#i-phone" /></svg></span><strong>No devices yet</strong>Sign in with the NeoPin app and its history shows up here.</div>';
  // The only stop of the day may have been removed: the way back stays here too.
  else if (!tl.data || tl.data.segments.length === 0)
    tlBody.innerHTML =
      '<div class="tl-note"><span class="empty__icon"><svg class="icon"><use href="#i-place" /></svg></span><strong>Nothing recorded</strong>This device did not report any positions on this day.</div>' +
      renderRemoved(tl.data?.dismissed);
  else tlBody.innerHTML = renderSummary(tl.data.summary) + renderSegments(tl.data.segments) + renderRemoved(tl.data.dismissed);
}

function updateNav() {
  const prev = tl.days.find((day) => day < tl.date);
  const next = [...tl.days].reverse().find((day) => day > tl.date);
  tlPrev.disabled = !prev;
  tlNext.disabled = !next;
  tlPrev.dataset.day = prev ?? "";
  tlNext.dataset.day = next ?? "";
}

// An open place picker or mode chooser would be wiped by a new list.
const editing = () => Boolean(tlBody.querySelector(".place-picker:not([hidden]), .mode-chooser:not([hidden])"));

// While names or paths are pending the same day is asked for again. A picker or chooser that is
// open holds the refresh back until it is closed, so a half typed name is not lost.
function scheduleRetry(id) {
  if (!stillPending(tl.data) || tl.retries >= PENDING_RETRIES) return;
  tl.retries += 1;
  const retry = () => {
    if (id !== tl.loadId || !tl.on) return;
    if (editing()) setTimeout(retry, PENDING_RETRY_MS);
    else loadDay({ keepView: true, auto: true });
  };
  setTimeout(retry, PENDING_RETRY_MS);
}

// keepView reloads the same day in place (new place names, smoother paths, a correction): the
// map and the list stay where they are. The focused segment is found again by its start, as a
// dismissed stop or a corrected trip can shift the others. auto marks a pending refresh.
async function loadDay({ keepView = false, auto = false } = {}) {
  const id = ++tl.loadId;
  const previous = keepView && tl.active !== null ? tl.data?.segments[tl.active] : null;
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
    // A picker opened while the refresh was on its way: this answer waits, it does not count.
    if (auto && editing()) {
      tl.retries -= 1;
      return scheduleRetry(id);
    }
    tl.data = data;
    renderBody("ready");
    ensureLayers();
    drawMarkers();
    if (keepView) {
      tlBody.scrollTop = scroll;
      const again = segmentIndex(data.segments, previous);
      tl.active = null;
      if (again >= 0) markActive(again);
      else map.getSource(TL_SOURCE)?.setData(linesData());
    } else fitDay();
    scheduleRetry(id);
  } catch (error) {
    if (id !== tl.loadId || error.message === "signed-out") return;
    // A failed refresh still counts, the next one is scheduled all the same.
    if (keepView) scheduleRetry(id);
    else renderBody("error");
  }
}

// Places

async function openPicker(index) {
  const segment = tl.data?.segments[index];
  const picker = tlBody.querySelector(`.place-picker[data-picker="${index}"]`);
  if (!segment || !picker) return;
  const open = picker.hidden;
  closeEditors();
  if (!open) return;
  picker.hidden = false;
  picker.innerHTML = '<div class="place-picker__note"><div class="spinner"></div></div>';
  let choices = [];
  try {
    choices = await getJson(withUser(`/api/places/nearby?lat=${segment.lat}&lon=${segment.lon}`));
  } catch (error) {
    if (error.message === "signed-out") return;
  }
  if (picker.hidden || !picker.isConnected) return;
  const current = segment.place;
  // Renaming an own place keeps what it is, Home stays Home.
  const ownKind = current?.source === "own" ? current.kind : null;
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
  const tags = QUICK_KINDS.map(
    (kind) => `<button class="chip chip--icon" type="button" data-tag="${kind}" aria-pressed="${ownKind === kind}" aria-label="Save as ${KIND_LABELS[kind]}">
        <svg class="icon"><use href="#i-${kind}" /></svg>${KIND_LABELS[kind]}
      </button>`
  ).join("");
  picker.innerHTML = `
    ${confirm}
    <div class="place-picker__list">${list}</div>
    <div class="place-picker__quick"><span>Save as</span>${tags}</div>
    <form class="place-picker__own">
      <input name="name" maxlength="80" placeholder="Name it yourself" required autocomplete="off" />
      <button class="place-picker__save" type="submit">Save</button>
    </form>
    <button class="place-picker__dismiss" type="button" data-dismiss aria-label="Not a stop, remove it from the day">
      <svg class="icon"><use href="#i-place-off" /></svg>Not a stop
    </button>
    <div class="place-picker__error" hidden>Could not save, try again.</div>`;
  picker.dataset.choices = JSON.stringify(choices);
  picker.dataset.kind = ownKind ?? "place";
}

// Runs one save from an open picker or chooser: everything in it waits, a failure says so in it.
async function saveFrom(box, action) {
  box.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
  try {
    await action();
    tl.retries = 0;
    await loadDay({ keepView: true });
    // Saved, but the day could not be fetched again: the editor closes, Reload shows the change.
    if (box.isConnected) box.hidden = true;
  } catch (error) {
    if (error.message === "signed-out" || !box.isConnected) return;
    box.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
    box.querySelector(".place-picker__error").hidden = false;
  }
}

// Saving names the spot of the visit. Picking an own place claims the spot for it. Home and
// Work go without a name, the server names them.
function savePlace(index, choice) {
  const segment = tl.data?.segments[index];
  const picker = tlBody.querySelector(`.place-picker[data-picker="${index}"]`);
  if (!segment || !picker || !choice) return;
  saveFrom(picker, () =>
    choice.source === "own" && choice.id
      ? sendJson(withUser(`/api/places/${choice.id}/claim`), "POST", { lat: segment.lat, lon: segment.lon })
      : sendJson(withUser("/api/places"), "POST", {
          lat: segment.lat,
          lon: segment.lon,
          kind: choice.kind,
          ...(choice.name && { name: choice.name }),
          ...(choice.osmId && { osmId: choice.osmId }),
        })
  );
}

// "Not a stop": a red light or a jam. The server keeps the span, the day is built again around it.
function dismissStop(index) {
  const segment = tl.data?.segments[index];
  const picker = tlBody.querySelector(`.place-picker[data-picker="${index}"]`);
  if (!segment || !picker) return;
  saveFrom(picker, () =>
    sendJson(withUser("/api/visits/dismissed"), "PUT", { deviceId: tl.deviceId, start: segment.start, end: segment.end, dismissed: true })
  );
}

async function restoreStop(span, button) {
  button.disabled = true;
  try {
    await sendJson(withUser("/api/visits/dismissed"), "PUT", { deviceId: tl.deviceId, start: span.start, end: span.end, dismissed: false });
    tl.retries = 0;
    await loadDay({ keepView: true });
    if (button.isConnected) button.disabled = false;
  } catch (error) {
    if (error.message === "signed-out") return;
    if (button.isConnected) button.disabled = false;
    toast("Could not save, try again.");
  }
}

// Trips

function closeEditors() {
  tlBody.querySelectorAll(".place-picker, .mode-chooser").forEach((el) => (el.hidden = true));
  tlBody.querySelectorAll(".seg--trip").forEach((el) => el.setAttribute("aria-expanded", "false"));
}

// A click on a trip opens its "This was:" chooser along with the focus on the map. True when it opened.
function toggleChooser(index) {
  const segment = tl.data?.segments[index];
  const chooser = tlBody.querySelector(`.mode-chooser[data-chooser="${index}"]`);
  if (!segment || !chooser) return false;
  const open = chooser.hidden;
  closeEditors();
  if (!open) return false;
  const chips = MODE_CHOICES.map((choice) => {
    const current = choice !== "auto" && choice === segment.mode;
    const label = choice === "auto" ? "Automatic" : MODES[choice].label;
    const icon = choice === "auto" ? "#i-refresh" : MODES[choice].icon;
    return `<button class="chip chip--icon" type="button" data-mode-choice="${choice}" aria-pressed="${current}" aria-label="This was ${label.toLowerCase()}">
        <svg class="icon"><use href="${icon}" /></svg>${label}
      </button>`;
  }).join("");
  chooser.innerHTML = `
    <span class="mode-chooser__label">This was:</span>
    <div class="mode-chooser__chips">${chips}</div>
    <div class="place-picker__error" hidden>Could not save, try again.</div>`;
  chooser.hidden = false;
  tlBody.querySelector(`.seg[data-index="${index}"]`)?.setAttribute("aria-expanded", "true");
  return true;
}

// "This was: Transit": the server keeps the correction, "auto" goes back to its own guess.
function correctTrip(index, mode) {
  const segment = tl.data?.segments[index];
  const chooser = tlBody.querySelector(`.mode-chooser[data-chooser="${index}"]`);
  if (!segment || !chooser) return;
  saveFrom(chooser, () => sendJson(withUser("/api/trips/mode"), "PUT", { deviceId: tl.deviceId, start: segment.start, mode }));
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
  let ids = tlPeople.find((p) => p.userId === tl.userId)?.devices ?? null;
  // Without the people list there are still the own devices.
  if (!ids && own) {
    try {
      ids = (await getJson("/api/devices")).map((d) => d.deviceId);
    } catch {
      ids = null;
    }
  }
  ids = [...(ids ?? [])].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
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

// The accounts whose timeline this one may read. The chooser shows once there is more than itself.
async function loadAccounts() {
  try {
    tlPeople = await getJson("/api/timeline/people");
  } catch {
    tlPeople = [];
  }
  if (!tlPeople.some((p) => p.userId === tl.userId)) tl.userId = me?.id ?? null;
  tlAccount.hidden = tlPeople.length < 2;
  tlAccount.replaceChildren(
    ...tlPeople.map((person) => {
      const option = document.createElement("option");
      option.value = String(person.userId);
      option.textContent = person.userId === me?.id ? `${person.displayName} (you)` : person.displayName;
      return option;
    })
  );
  if (tl.userId !== null) tlAccount.value = String(tl.userId);
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
// The days may have grown too, so both are fetched again.
tlReload.addEventListener("click", () => loadDays());

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
  if (event.target.closest("[data-retry]")) return loadDay();
  const restore = event.target.closest("[data-restore]");
  if (restore) {
    const span = tl.data?.dismissed?.[Number(restore.dataset.restore)];
    if (span) restoreStop(span, restore);
    return;
  }
  const edit = event.target.closest(".seg__edit");
  if (edit) return openPicker(Number(edit.dataset.edit));
  const chooser = event.target.closest(".mode-chooser");
  if (chooser) {
    const choice = event.target.closest("[data-mode-choice]");
    if (choice) correctTrip(Number(chooser.dataset.chooser), choice.dataset.modeChoice);
    return;
  }
  const picker = event.target.closest(".place-picker");
  if (picker) {
    const index = Number(picker.dataset.picker);
    const pick = event.target.closest("[data-choice]");
    if (pick) savePlace(index, JSON.parse(picker.dataset.choices ?? "[]")[Number(pick.dataset.choice)]);
    const tag = event.target.closest("[data-tag]");
    if (tag) savePlace(index, { kind: tag.dataset.tag, source: "tag" });
    if (event.target.closest("[data-dismiss]")) dismissStop(index);
    if (event.target.closest("[data-confirm]")) {
      const { name, kind, osmId } = tl.data.segments[index].place;
      savePlace(index, { name, kind, osmId, source: "osm" });
    }
    return;
  }
  const seg = event.target.closest(".seg");
  if (!seg) return;
  const index = Number(seg.dataset.index);
  // A shared day has no "This was:" chooser.
  if (seg.classList.contains("seg--trip")) focusSegment(index, { fold: readOnly() || !toggleChooser(index) });
  else focusSegment(index);
});

tlBody.addEventListener("submit", (event) => {
  const form = event.target.closest(".place-picker__own");
  if (!form) return;
  event.preventDefault();
  const name = form.elements.name.value.trim();
  if (!name) return;
  const picker = form.closest(".place-picker");
  savePlace(Number(picker.dataset.picker), { name, kind: picker.dataset.kind || "place", source: "typed" });
});

// On a phone a tap on the head folds the sheet or brings the list back.
tlPanel.querySelector(".timeline__head").addEventListener("click", (event) => {
  if (phone.matches && !event.target.closest("button")) setSheetOpen(tlPanel.dataset.open !== "true");
});

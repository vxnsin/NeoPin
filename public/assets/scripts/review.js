// The weekly and monthly review: how far, how long, by which means, on which lines and where,
// next to the period before. Opens from the account menu and from a review notification.
// Modes, lines and places look the way they do in the timeline (trips.js, timeline.js, alerts.js).
const REVIEW_TITLE = "Review";
const REVIEW_SOURCE = "review-path";

const review = { period: "week", date: null, data: null, loadId: 0, map: null, notify: null };

const reviewOpen = () => !modal.hidden && modalTitle.textContent === REVIEW_TITLE;
// The browser's zone, so a week that spans a change of the clocks still has whole days.
const reviewZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

const isoDay = (date) => date.toISOString().slice(0, 10);
const dayOf = (iso) => new Date(`${iso}T00:00:00Z`);
const shiftDays = (iso, days) => isoDay(new Date(dayOf(iso).getTime() + days * 86_400_000));
const localToday = () => isoDay(new Date(Date.now() - new Date().getTimezoneOffset() * 60_000));
// The dashboard speaks English, the dates too.
const fmt = (iso, options) => dayOf(iso).toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });

// "19 – 25 Oct 2026", "28 Sep – 4 Oct 2026", "October 2026"
function periodLabel(data) {
  if (data.period === "month") return fmt(data.from, { month: "long", year: "numeric" });
  const sameMonth = data.from.slice(0, 7) === data.to.slice(0, 7);
  const start = sameMonth ? fmt(data.from, { day: "numeric" }) : fmt(data.from, { day: "numeric", month: "short" });
  return `${start} – ${fmt(data.to, { day: "numeric", month: "short", year: "numeric" })}`;
}

const minutesText = (minutes) => (minutes ? formatDuration(minutes * 60_000) : "0 min");
const kmText = (km) => `${km >= 100 || Number.isInteger(km) ? Math.round(km) : km.toFixed(1)} km`;

// "+12% vs last week", against the period before; nothing when there was none.
function changeHtml(now, before, label) {
  if (before === null || before === undefined) return "";
  if (before === 0) return now > 0 ? `<span class="rv-change rv-change--up">new vs ${label}</span>` : "";
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return `<span class="rv-change">same as ${label}</span>`;
  return `<span class="rv-change rv-change--${pct > 0 ? "up" : "down"}">${pct > 0 ? "+" : "−"}${Math.abs(pct)}% vs ${label}</span>`;
}

function statsHtml(data) {
  const last = data.period === "week" ? "last week" : "last month";
  const prev = data.previous;
  return `
    <div class="rv-stats">
      <div class="rv-stat rv-stat--big"><span>Distance</span><strong>${esc(kmText(data.distanceKm))}</strong>${changeHtml(data.distanceKm, prev?.distanceKm, last)}</div>
      <div class="rv-stat rv-stat--big"><span>On the move</span><strong>${esc(minutesText(data.movingMinutes))}</strong>${changeHtml(data.movingMinutes, prev?.movingMinutes, last)}</div>
      <div class="rv-stat"><span>Trips</span><strong>${data.trips}</strong></div>
      <div class="rv-stat"><span>Stops</span><strong>${data.stops}</strong></div>
      <div class="rv-stat"><span>New places</span><strong>${data.newPlaces}</strong></div>
    </div>`;
}

// One bar per day; the week names its days, the month numbers them.
function daysHtml(data) {
  const max = Math.max(...data.days.map((d) => d.km), 0);
  const today = localToday();
  const bars = data.days
    .map((d) => {
      const label = data.period === "week" ? fmt(d.date, { weekday: "short" }) : String(Number(d.date.slice(8)));
      const tip = `${fmt(d.date, { weekday: "long", day: "numeric", month: "long" })}: ${kmText(d.km)}, ${minutesText(d.movingMinutes)}`;
      const height = max ? Math.max(d.km ? 4 : 0, Math.round((d.km / max) * 100)) : 0;
      return `
        <button class="rv-bar${d.date === today ? " is-today" : ""}" type="button" data-review-day="${d.date}" title="${esc(tip)}" aria-label="${esc(tip)}">
          <span class="rv-bar__fill" style="height:${height}%"></span>
          <span class="rv-bar__label">${esc(label)}</span>
        </button>`;
    })
    .join("");
  return `<p class="gsection">Per day</p><div class="rv-bars rv-bars--${data.period}">${bars}</div>`;
}

function modesHtml(data) {
  const entries = Object.entries(data.byMode).filter(([, m]) => m.km > 0 || m.minutes > 0);
  if (!entries.length) return "";
  const total = entries.reduce((sum, [, m]) => sum + m.km, 0) || 1;
  const stack = entries
    .map(([mode, m]) => `<span style="flex:${Math.max(m.km, 0.01)};background:${MODES[mode].color}" title="${esc(MODES[mode].label)}"></span>`)
    .join("");
  const rows = entries
    .map(
      ([mode, m]) => `
      <li class="row rv-mode">
        <span class="row__icon" style="color:${MODES[mode].color}"><svg class="icon"><use href="${MODES[mode].icon}" /></svg></span>
        <span class="row__text"><strong>${esc(MODES[mode].label)}</strong><span>${esc(kmText(m.km))} · ${esc(minutesText(m.minutes))}</span></span>
        <span class="rv-share">${Math.round((m.km / total) * 100)}%</span>
      </li>`
    )
    .join("");
  return `<p class="gsection">How you got around</p><div class="rv-stack" aria-hidden="true">${stack}</div><ul class="rows rows--tight">${rows}</ul>`;
}

function linesHtml(data) {
  if (!data.transit.length) return "";
  const rows = data.transit
    .map(
      (line) => `
      <li class="row rv-line">
        ${lineBadge(line)}
        <span class="row__text"><strong>${esc(TRANSIT_KINDS[line.kind]?.label ?? "Transit")} ${esc(line.line)}</strong></span>
        <span class="rv-share">${line.rides} ${line.rides === 1 ? "ride" : "rides"}</span>
      </li>`
    )
    .join("");
  return `<p class="gsection">Lines</p><ul class="rows rows--tight">${rows}</ul>`;
}

function placesHtml(data) {
  if (!data.topPlaces.length) return "";
  const rows = data.topPlaces
    .map(
      (place) => `
      <li class="row">
        <span class="row__icon"><svg class="icon"><use href="${placeIcon(place.kind)}" /></svg></span>
        <span class="row__text"><strong>${esc(place.name)}</strong><span>${place.kind !== "place" && KIND_LABELS[place.kind] && KIND_LABELS[place.kind] !== place.name ? `${esc(KIND_LABELS[place.kind])} · ` : ""}${esc(minutesText(place.minutes))}</span></span>
        <span class="rv-share">${place.visits}×</span>
      </li>`
    )
    .join("");
  return `<p class="gsection">Places</p><ul class="rows rows--tight">${rows}</ul>`;
}

function notifyHtml() {
  if (review.notify === null) return "";
  return `
    <label class="row rv-notify">
      <span class="row__icon"><svg class="icon"><use href="#i-bell" /></svg></span>
      <span class="row__text"><strong>Review notification</strong><span>Mondays for the week, on the first for the month</span></span>
      <span class="switch">
        <input type="checkbox" role="switch" data-review-notify${review.notify ? " checked" : ""} aria-label="Review notification" />
        <span class="switch__track" aria-hidden="true"></span>
      </span>
    </label>`;
}

function reviewHead(data) {
  const chip = (period, label) =>
    `<button class="chip" type="button" data-review-period="${period}" aria-pressed="${review.period === period}">${label}</button>`;
  const latest = data && data.to >= localToday();
  return `
    <div class="rv-head">
      <div class="chips rv-periods" role="group" aria-label="Period">${chip("week", "Week")}${chip("month", "Month")}</div>
      <div class="daynav rv-nav">
        <button class="icon-btn" type="button" data-review-step="-1" aria-label="Previous ${review.period}" title="Previous ${review.period}"><svg class="icon"><use href="#i-prev" /></svg></button>
        <strong class="rv-label">${data ? esc(periodLabel(data)) : "…"}</strong>
        <button class="icon-btn" type="button" data-review-step="1" aria-label="Next ${review.period}" title="Next ${review.period}"${latest ? " disabled" : ""}><svg class="icon"><use href="#i-next" /></svg></button>
      </div>
    </div>`;
}

function renderReview() {
  const data = review.data;
  if (!data) return;
  const body = data.empty
    ? `<div class="tl-note"><span class="empty__icon"><svg class="icon"><use href="#i-timeline" /></svg></span><strong>Nothing recorded</strong>No trips or stops this ${esc(data.period)}. The review is made from the timeline of your devices.</div>`
    : `${statsHtml(data)}
       <div class="rv-map" id="reviewMap" role="img" aria-label="Map of the ways of this ${esc(data.period)}"></div>
       ${daysHtml(data)}
       ${modesHtml(data)}
       ${linesHtml(data)}
       ${placesHtml(data)}`;
  modalBody.innerHTML = `<div class="rv">${reviewHead(data)}${body}${notifyHtml()}</div>`;
  drawReviewMap(data);
}

// ---- map ----

function removeReviewMap() {
  review.map?.remove();
  review.map = null;
}

function reviewLine(data) {
  return {
    type: "FeatureCollection",
    features:
      data.path.length > 1
        ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: data.path.map(([lat, lon]) => [lon, lat]) } }]
        : [],
  };
}

function addReviewLayers(mini, data) {
  if (!mini.getSource(REVIEW_SOURCE)) {
    mini.addSource(REVIEW_SOURCE, { type: "geojson", data: reviewLine(data) });
    mini.addLayer({
      id: "rv-casing",
      type: "line",
      source: REVIEW_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-opacity": 0.85, "line-width": 6 },
    });
    mini.addLayer({
      id: "rv-line",
      type: "line",
      source: REVIEW_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() || "#d3171e", "line-width": 3.5 },
    });
  }
}

function drawReviewMap(data) {
  removeReviewMap();
  const container = document.getElementById("reviewMap");
  if (!container || data.path.length < 2) {
    if (container) container.hidden = true;
    return;
  }
  const dark = window.neopinTheme.get() === "dark";
  // Without a style of its own the style is loaded once, tuned for the dark theme where it applies.
  const mini = new maplibregl.Map({
    container,
    attributionControl: false,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    cooperativeGestures: phone.matches,
  });
  mini.setStyle(MAP_STYLES[dark ? "dark" : "light"], { diff: false, transformStyle: transformStyle(dark) });
  mini.touchZoomRotate.disableRotation();
  mini.on("styleimagemissing", (event) => {
    if (!mini.hasImage(event.id)) mini.addImage(event.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
  mini.on("style.load", () => addReviewLayers(mini, data));
  const points = data.path.map(([lat, lon]) => [lon, lat]);
  const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
  mini.fitBounds(bounds, { padding: 28, maxZoom: 15, duration: 0 });
  review.map = mini;
}

// ---- loading ----

async function loadReview() {
  const id = ++review.loadId;
  const params = new URLSearchParams({ period: review.period, tz: String(new Date().getTimezoneOffset()) });
  const zone = reviewZone();
  if (zone) params.set("timeZone", zone);
  if (review.date) params.set("date", review.date);
  if (!review.data) {
    modalBody.innerHTML = `<div class="rv">${reviewHead(null)}<div class="tl-note"><div class="spinner"></div></div></div>`;
  } else modalBody.querySelector(".rv")?.classList.add("is-loading");
  try {
    const data = await call(`/api/review?${params}`);
    if (id !== review.loadId || !reviewOpen()) return;
    review.data = data;
    review.date = data.from;
    renderReview();
  } catch (error) {
    if (error.message === "signed-out" || id !== review.loadId || !reviewOpen()) return;
    removeReviewMap();
    note(`<strong>Could not load the review</strong>${esc(error.message)}`);
  }
}

async function loadReviewSetting() {
  try {
    review.notify = (await call("/api/me/review-notifications")).enabled;
  } catch {
    review.notify = null;
  }
  if (reviewOpen() && review.data) renderReview();
}

// `period` and `date` (any day in it) pick what opens; without a date the last finished one.
function showReview({ period = "week", date = null } = {}) {
  openModal(REVIEW_TITLE);
  modal.querySelector(".modal__card").classList.add("modal__card--wide");
  review.period = period;
  review.date = date;
  review.data = null;
  modalCleanup = () => {
    review.loadId++;
    removeReviewMap();
    modal.querySelector(".modal__card").classList.remove("modal__card--wide");
  };
  loadReview();
  loadReviewSetting();
}

modalBody.addEventListener("click", (event) => {
  if (!reviewOpen()) return;
  const period = event.target.closest("[data-review-period]");
  if (period && period.dataset.reviewPeriod !== review.period) {
    review.period = period.dataset.reviewPeriod;
    // The other kind of period around the last day on screen (a week in two months goes to the later one), today at most.
    const today = localToday();
    review.date = review.data ? [review.data.to, today].sort()[0] : null;
    loadReview();
    return;
  }
  const step = event.target.closest("[data-review-step]");
  if (step && !step.disabled && review.data) {
    review.date = Number(step.dataset.reviewStep) < 0 ? shiftDays(review.data.from, -1) : shiftDays(review.data.to, 1);
    loadReview();
  }
});

modalBody.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-review-notify]");
  if (!input || !reviewOpen()) return;
  const enabled = input.checked;
  try {
    review.notify = (await call("/api/me/review-notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    })).enabled;
    toast(enabled ? "You get a review every Monday and on the first of the month." : "No more review notifications.");
  } catch (error) {
    input.checked = !enabled;
    if (error.message !== "signed-out") toast("Could not save, try again.");
  }
});

// The small map follows the theme like the big one.
document.documentElement.addEventListener("themechange", () => {
  if (reviewOpen() && review.data && !review.data.empty) drawReviewMap(review.data);
});

document.getElementById("openReview").addEventListener("click", () => {
  setMenu(false);
  showReview();
});

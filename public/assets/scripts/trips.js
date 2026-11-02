// How a trip of the timeline looks: its mode, the line it was matched to, its colour and icon.
// Labels, colours and icons follow the app, so a day looks the same on the phone and here.
// Plain functions without the page, so the tests can run this file as it is.
const MODES = {
  walking: { label: "Walking", icon: "#i-walk", color: "#0284c7" },
  cycling: { label: "Cycling", icon: "#i-bike", color: "#16a34a" },
  driving: { label: "Driving", icon: "#i-car", color: "#d3171e" },
  transit: { label: "Transit", icon: "#i-train", color: "#7c3aed" },
};
// The order of the "This was:" chooser under a trip, with the way back to the server's guess last.
const MODE_CHOICES = ["walking", "cycling", "driving", "transit", "auto"];
const TRANSIT_KINDS = {
  bus: { label: "Bus", icon: "#i-bus" },
  tram: { label: "Tram", icon: "#i-tram" },
  subway: { label: "Subway", icon: "#i-train" },
  train: { label: "Train", icon: "#i-train" },
  ferry: { label: "Ferry", icon: "#i-ferry" },
};
// A stretch without fixes is drawn thin, dashed and grey.
const GAP_COLOR = "#94a3b8";

// Line colours come from timetable feeds: only plain hex goes into a style or the map.
function safeColor(value) {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : null;
}

// Dark or light text on a coloured badge.
function textOn(hex) {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#0f172a" : "#ffffff";
}

// The line's own colours; a feed that names a colour but no text colour gets readable text.
// Both null for a line without colours, it gets a quiet badge.
function badgeColors(transit) {
  const bg = safeColor(transit?.color);
  return { bg, fg: safeColor(transit?.textColor) ?? (bg ? textOn(bg) : null) };
}

// A matched line draws in its own colour, everything else in the mode's.
function tripColor(trip) {
  if (trip.gap) return GAP_COLOR;
  return safeColor(trip.transit?.color) ?? MODES[trip.mode]?.color ?? "#64748b";
}

// The vehicle when a line was matched, otherwise the mode.
function tripIcon(trip) {
  if (trip.gap) return "#i-gap";
  return TRANSIT_KINDS[trip.transit?.kind]?.icon ?? MODES[trip.mode]?.icon ?? MODES.walking.icon;
}

// "Bus" for a matched line, "Transit" for a ride the person named without a known line.
function rideLabel(transit) {
  return TRANSIT_KINDS[transit?.kind]?.label ?? MODES.transit.label;
}

// The server is still filling in place names or smoothing paths: asking again shortly has them.
function stillPending(data) {
  return Boolean(data?.placesPending || data?.pathsPending);
}

// Where a segment is in a fresh copy of the day: a dismissed stop or a corrected trip can shift
// the others, so it is found by its kind and start. -1 when it is gone.
function segmentIndex(segments, segment) {
  if (!segment) return -1;
  return segments.findIndex((s) => s.type === segment.type && s.start === segment.start);
}

// ---- heights ----
// The server gives the ground under the fixes, null where it does not know it (an older server,
// ELEVATION off, the tile still on its way); then nothing about heights is shown.

const isMetres = (value) => typeof value === "number" && Number.isFinite(value);

// "412 m", "2,962 m"
function altitudeText(metres) {
  return isMetres(metres) ? `${Math.round(metres).toLocaleString("en-GB")} m` : "";
}

// "↑ 120 m · ↓ 30 m" for a trip that went up or down, "" for a flat one or without heights.
function climbText(trip) {
  const up = isMetres(trip?.ascentM) && trip.ascentM >= 1 ? `↑ ${altitudeText(trip.ascentM)}` : "";
  const down = isMetres(trip?.descentM) && trip.descentM >= 1 ? `↓ ${altitudeText(trip.descentM)}` : "";
  return [up, down].filter(Boolean).join(" · ");
}

// The outline of a trip's elevation profile in a width × height box, as an SVG path that is
// closed along the bottom, and its lowest and highest metres. Null without two points. A small
// rise does not fill the box: it stretches over at least `minRangeM`.
function profileShape(elevation, width = 200, height = 36, minRangeM = 40) {
  const points = Array.isArray(elevation) ? elevation.filter((p) => Array.isArray(p) && isMetres(p[0]) && isMetres(p[1])) : [];
  if (points.length < 2) return null;
  const heights = points.map((p) => p[1]);
  const low = Math.min(...heights);
  const high = Math.max(...heights);
  const range = Math.max(minRangeM, high - low);
  const base = low - (range - (high - low)) / 2;
  const first = points[0][0];
  const span = points[points.length - 1][0] - first || 1;
  const top = 2;
  const round = (value) => Math.round(value * 10) / 10;
  const xy = points.map(([d, h]) => [round(((d - first) / span) * width), round(top + (1 - (h - base) / range) * (height - top))]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
  return { line, area: `${line} L${width} ${height} L0 ${height} Z`, low, high };
}

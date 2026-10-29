import crypto from "crypto";
import chalk from "chalk";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { getUser, listUsers } from "./accounts.js";
import { distanceM, dismissedVisits, positionsBetween } from "./history.js";
import { addNotification } from "./notifications.js";
import { lookupEnabled, namePlaces } from "./places.js";
import { smoothPaths } from "./paths.js";
import { buildTimeline } from "./timeline.js";
import { TRIP_MODES, matchTransit } from "./transitMatch.js";

// The weekly and monthly review: how far someone went, how long they were on the move, by which
// means, on which lines and where they stayed. Every day is the own timeline of that day, built
// the way GET /api/timeline builds it (own fixes, dismissed stops, corrections, place names), from
// the device that recorded the most fixes that day. Finished days are kept in review_days with a
// stamp of everything they were made from, so a month is quick and a change shows the next time.

export const REVIEW_PERIODS = ["week", "month"];
// Raise when what a day holds changes: every stored day is built again.
const ALGO = 1;
const MAX_PATH_POINTS = 600;
const DAY_PATH_POINTS = 300;
const TOP_PLACES = 5;
const TOP_LINES = 10;
// A stay this close to one before the period is no new place.
const NEW_PLACE_M = 100;
// The notifications go out at this hour, server time (TZ).
const NOTIFY_HOUR = 9;
const JOB_EVERY_MS = 60_000;
const DAY_MS = 86_400_000;

// ---- calendar ----

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Midnight UTC of a "YYYY-MM-DD", null for anything else (2025-02-30 included).
export function parseDate(text) {
  const match = DATE_RE.exec(text ?? "");
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
}

const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date, days) => isoOf(parseDate(date) + days * DAY_MS);

export function datesBetween(from, to) {
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

// The week (Monday to Sunday) or calendar month that holds `date`.
export function periodOf(period, date) {
  const ms = parseDate(date);
  if (period === "week") {
    const fromMonday = (new Date(ms).getUTCDay() + 6) % 7;
    const from = addDays(date, -fromMonday);
    return { from, to: addDays(from, 6) };
  }
  const d = new Date(ms);
  return {
    from: isoOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
    to: isoOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)),
  };
}

export const previousPeriod = (period, from) => periodOf(period, addDays(from, -1));

// The last week or month that is over on `today`.
export const lastCompleted = (period, today) => previousPeriod(period, periodOf(period, today).from);

// ---- time zones ----
// A zone says, for a local date, what JavaScript's getTimezoneOffset() gives at its midnight
// (UTC minus local, in minutes), and which local date it is at a moment.

export function fixedZone(tzOffsetMin) {
  return {
    offsetFor: () => tzOffsetMin,
    today: (now) => isoOf(now - tzOffsetMin * 60_000),
  };
}

// The server's own zone (TZ), with its summer time.
export const serverZone = {
  offsetFor(date) {
    const d = new Date(parseDate(date));
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTimezoneOffset();
  },
  today(now) {
    const d = new Date(now);
    return isoOf(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  },
};

// An IANA zone such as "Europe/Berlin". Throws a RangeError for an unknown one.
export function namedZone(timeZone) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const localMs = (ms) => {
    const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  };
  const offsetAt = (ms) => Math.round((Math.floor(ms / 1000) * 1000 - localMs(ms)) / 60_000);
  return {
    offsetFor(date) {
      const midnight = parseDate(date);
      const guess = offsetAt(midnight);
      return offsetAt(midnight + guess * 60_000);
    },
    today: (now) => isoOf(localMs(now)),
  };
}

// Start and end of a local day in ms. 23 or 25 hours long where the clocks change.
export function dayBounds(date, zone) {
  const next = addDays(date, 1);
  return {
    from: parseDate(date) + zone.offsetFor(date) * 60_000,
    to: parseDate(next) + zone.offsetFor(next) * 60_000,
  };
}

// ---- one day ----

const round1 = (value) => Math.round(value * 10) / 10;
const round5 = (value) => Math.round(value * 1e5) / 1e5;

// Every device that ever reported for the account, found by skipping through the index.
function deviceIdsOf(userId) {
  return getDb()
    .prepare(
      `WITH RECURSIVE d(id) AS (
         SELECT MIN(device_id) FROM positions WHERE user_id = ?
         UNION ALL
         SELECT (SELECT MIN(device_id) FROM positions WHERE user_id = ? AND device_id > d.id) FROM d WHERE d.id IS NOT NULL
       ) SELECT id FROM d WHERE id IS NOT NULL`
    )
    .all(userId, userId)
    .map((r) => r.id);
}

// How many fixes each device has in the range, and its newest row: a fix sent in later changes it.
function deviceCounts(userId, devices, from, to) {
  const count = getDb().prepare("SELECT COUNT(*) AS n, MAX(id) AS last FROM positions WHERE user_id = ? AND device_id = ? AND ts >= ? AND ts < ?");
  return devices
    .map((deviceId) => {
      const row = count.get(userId, deviceId, from, to);
      return { deviceId, n: Number(row.n), last: Number(row.last ?? 0) };
    })
    .filter((d) => d.n > 0);
}

// The device with the most fixes stands for the day; on a tie the account's main device.
function dayDevice(counts, primary) {
  let best = null;
  for (const d of counts) {
    if (!best || d.n > best.n || (d.n === best.n && d.deviceId === primary)) best = d;
  }
  return best?.deviceId ?? null;
}

// What every day of the account depends on: the own places (names), the timetable data, the
// switches that change what a timeline holds.
function accountStamp(userId) {
  const db = getDb();
  const places = db.prepare("SELECT id, name, kind, lat, lon, radius_m FROM places WHERE user_id = ? ORDER BY id").all(userId);
  const feeds = Number(db.prepare("SELECT MAX(updated_at) AS stamp FROM transit_feeds").get().stamp ?? 0);
  return JSON.stringify([ALGO, places, feeds, config.transit, !!config.roadMatchUrl, lookupEnabled()]);
}

// Everything a day is made from: which fixes of which device, the dismissed stops, the
// corrections and ride answers of its trips.
function dayStamp(userId, deviceId, counts, from, to, account) {
  const db = getDb();
  const modes = db
    .prepare("SELECT start, mode FROM trip_modes WHERE user_id = ? AND device_id = ? AND start >= ? AND start < ? ORDER BY start")
    .all(userId, deviceId, from, to);
  const answers = db
    .prepare("SELECT ride_id, answer FROM ride_answers WHERE user_id = ? AND device_id = ? AND boarded_at >= ? AND boarded_at < ? ORDER BY ride_id")
    .all(userId, deviceId, from - 5 * 60_000, to);
  const parts = [account, deviceId, counts, dismissedVisits(userId, deviceId, from, to), modes, answers];
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("base64url");
}

const placeKey = (place) => (place.source === "own" ? `own:${place.id}` : `osm:${place.osmId ?? place.name}`);

// A line through points in metres, Douglas-Peucker with a tolerance that grows until it fits.
export function simplifyPath(points, max) {
  if (points.length <= max) return points;
  const lat0 = (points[0][0] * Math.PI) / 180;
  const xy = points.map(([lat, lon]) => [lon * 111_320 * Math.cos(lat0), lat * 110_540]);
  const keepWith = (epsilon) => {
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = xy[a];
      const [bx, by] = xy[b];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let far = -1;
      let farD = epsilon;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = xy[i];
        const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
        if (d > farD) {
          far = i;
          farD = d;
        }
      }
      if (far >= 0) {
        keep[far] = 1;
        stack.push([a, far], [far, b]);
      }
    }
    return points.filter((_, i) => keep[i]);
  };
  let epsilon = 5;
  let out = keepWith(epsilon);
  while (out.length > max) {
    epsilon *= 2;
    out = keepWith(epsilon);
  }
  return out;
}

const emptyModes = () => Object.fromEntries(TRIP_MODES.map((mode) => [mode, { m: 0, ms: 0 }]));

// What the review needs of a day's timeline.
export function summarizeDay(segments) {
  const trips = segments.filter((s) => s.type === "trip" && !s.gap);
  const visits = segments.filter((s) => s.type === "visit");
  const byMode = emptyModes();
  const lines = new Map();
  const path = [];
  for (const trip of trips) {
    const mode = byMode[trip.mode] ?? byMode.walking;
    mode.m += trip.distanceM;
    mode.ms += trip.durationMs;
    if (trip.transit) {
      const key = `${trip.transit.kind}:${trip.transit.line}`;
      const line = lines.get(key) ?? { kind: trip.transit.kind, line: trip.transit.line, color: null, rides: 0 };
      line.color ??= trip.transit.color ?? null;
      line.rides += 1;
      lines.set(key, line);
    }
    for (const point of trip.path) path.push([round5(point[0]), round5(point[1])]);
  }
  const places = new Map();
  for (const visit of visits) {
    if (!visit.place) continue;
    const key = placeKey(visit.place);
    const place = places.get(key) ?? { key, name: visit.place.name, kind: visit.place.kind, visits: 0, ms: 0, lat: round5(visit.lat), lon: round5(visit.lon) };
    place.visits += 1;
    place.ms += visit.durationMs;
    places.set(key, place);
  }
  return {
    m: trips.reduce((sum, t) => sum + t.distanceM, 0),
    ms: trips.reduce((sum, t) => sum + t.durationMs, 0),
    trips: trips.length,
    stops: visits.length,
    byMode,
    lines: [...lines.values()],
    places: [...places.values()],
    spots: visits.map((v) => [round5(v.lat), round5(v.lon)]),
    path: simplifyPath(path, DAY_PATH_POINTS),
  };
}

const EMPTY_DAY = summarizeDay([]);

// The day as the own timeline shows it, and whether a place name or a path is still on its way.
async function buildDay(userId, deviceId, from, to, tzOffsetMin) {
  const points = positionsBetween(userId, deviceId, from, to);
  const timeline = buildTimeline(points, { dismissed: dismissedVisits(userId, deviceId, from, to) });
  const [places, paths] = await Promise.all([
    namePlaces(userId, timeline.segments, { tzOffsetMin }),
    matchTransit(userId, deviceId, timeline.segments).then(() => smoothPaths(userId, deviceId, timeline.segments)),
  ]);
  return { day: summarizeDay(timeline.segments), pending: places.pending || paths.pending };
}

// The days of a range, from the store where nothing changed. Only days that are over are kept,
// and only once their place names and paths are complete.
export async function reviewDays(userId, dates, zone, { now = Date.now(), devices = deviceIdsOf(userId), account = accountStamp(userId) } = {}) {
  const db = getDb();
  const primary = getUser(userId)?.primary_device_id ?? null;
  const read = db.prepare("SELECT stamp, data FROM review_days WHERE user_id = ? AND start_ms = ? AND end_ms = ?");
  const write = db.prepare("INSERT OR REPLACE INTO review_days (user_id, start_ms, end_ms, date, stamp, data) VALUES (?, ?, ?, ?, ?, ?)");
  const writeSpots = db.prepare("INSERT OR REPLACE INTO review_spots (user_id, date, spots) VALUES (?, ?, ?)");
  return Promise.all(
    dates.map(async (date) => {
      const { from, to } = dayBounds(date, zone);
      if (from > now) return { date, ...EMPTY_DAY };
      const counts = deviceCounts(userId, devices, from, to);
      const deviceId = dayDevice(counts, primary);
      if (!deviceId) return { date, ...EMPTY_DAY };
      const stamp = dayStamp(userId, deviceId, counts, from, to, account);
      const stored = read.get(userId, from, to);
      if (stored?.stamp === stamp) return { date, ...JSON.parse(stored.data) };
      const { day, pending } = await buildDay(userId, deviceId, from, to, zone.offsetFor(date));
      if (to <= now && !pending) {
        write.run(userId, from, to, date, stamp, JSON.stringify(day));
        writeSpots.run(userId, date, JSON.stringify(day.spots));
      }
      return { date, ...day };
    })
  );
}

// ---- new places ----

// Where the account stayed on every finished day before `before`. Days that are not known yet
// are built once from their fixes alone (no names, no lines), so this is quick after the first time.
function staysBefore(userId, before, zone, now, devices) {
  const db = getDb();
  const limit = [before, zone.today(now)].sort()[0];
  const known = db.prepare("SELECT complete_before FROM review_history WHERE user_id = ?").get(userId)?.complete_before;
  let start = known;
  if (!start) {
    const first = devices
      .map((d) => db.prepare("SELECT MIN(ts) AS ts FROM positions WHERE user_id = ? AND device_id = ?").get(userId, d).ts)
      .filter((ts) => ts !== null)
      .map(Number);
    start = first.length ? zone.today(Math.min(...first)) : limit;
  }
  if (start < limit) {
    const has = db.prepare("SELECT 1 FROM review_spots WHERE user_id = ? AND date = ?");
    const write = db.prepare("INSERT OR REPLACE INTO review_spots (user_id, date, spots) VALUES (?, ?, ?)");
    const primary = getUser(userId)?.primary_device_id ?? null;
    for (let date = start; date < limit; date = addDays(date, 1)) {
      if (has.get(userId, date)) continue;
      const { from, to } = dayBounds(date, zone);
      const deviceId = dayDevice(deviceCounts(userId, devices, from, to), primary);
      if (!deviceId) continue;
      const timeline = buildTimeline(positionsBetween(userId, deviceId, from, to), { dismissed: dismissedVisits(userId, deviceId, from, to) });
      const spots = timeline.segments.filter((s) => s.type === "visit").map((v) => [round5(v.lat), round5(v.lon)]);
      write.run(userId, date, JSON.stringify(spots));
    }
    db.prepare("INSERT OR REPLACE INTO review_history (user_id, complete_before) VALUES (?, ?)").run(userId, [known ?? "", limit].sort()[1]);
  }
  return db
    .prepare("SELECT spots FROM review_spots WHERE user_id = ? AND date < ?")
    .all(userId, before)
    .flatMap((r) => JSON.parse(r.spots));
}

// ---- the review ----

function totals(days) {
  return {
    m: days.reduce((sum, d) => sum + d.m, 0),
    ms: days.reduce((sum, d) => sum + d.ms, 0),
    trips: days.reduce((sum, d) => sum + d.trips, 0),
    stops: days.reduce((sum, d) => sum + d.stops, 0),
  };
}

// `date` is any day of the period, without one the last finished period in the zone.
export async function buildReview(userId, { period = "week", date = null, zone = serverZone, now = Date.now() } = {}) {
  const { from, to } = date ? periodOf(period, date) : lastCompleted(period, zone.today(now));
  const devices = deviceIdsOf(userId);
  const account = accountStamp(userId);
  const options = { now, devices, account };
  const previousRange = previousPeriod(period, from);
  const [days, previousDays] = await Promise.all([
    reviewDays(userId, datesBetween(from, to), zone, options),
    reviewDays(userId, datesBetween(previousRange.from, previousRange.to), zone, options),
  ]);

  const sum = totals(days);
  const byMode = emptyModes();
  const lines = new Map();
  const places = new Map();
  for (const day of days) {
    for (const mode of TRIP_MODES) {
      byMode[mode].m += day.byMode[mode].m;
      byMode[mode].ms += day.byMode[mode].ms;
    }
    for (const line of day.lines) {
      const key = `${line.kind}:${line.line}`;
      const known = lines.get(key);
      if (known) {
        known.rides += line.rides;
        known.color ??= line.color;
      } else lines.set(key, { ...line });
    }
    for (const place of day.places) {
      const known = places.get(place.key);
      if (known) {
        known.visits += place.visits;
        known.ms += place.ms;
        // The newest name wins, a place may have been renamed.
        known.name = place.name;
        known.kind = place.kind;
      } else places.set(place.key, { ...place });
    }
  }

  let newPlaces = 0;
  if (places.size) {
    const before = staysBefore(userId, from, zone, now, devices);
    for (const place of places.values()) {
      if (!before.some(([lat, lon]) => distanceM(lat, lon, place.lat, place.lon) <= NEW_PLACE_M)) newPlaces += 1;
    }
  }

  const previous = totals(previousDays);
  return {
    period,
    from,
    to,
    distanceKm: round1(sum.m / 1000),
    movingMinutes: Math.round(sum.ms / 60_000),
    trips: sum.trips,
    stops: sum.stops,
    byMode: Object.fromEntries(TRIP_MODES.map((mode) => [mode, { km: round1(byMode[mode].m / 1000), minutes: Math.round(byMode[mode].ms / 60_000) }])),
    transit: [...lines.values()]
      .sort((a, b) => b.rides - a.rides || a.line.localeCompare(b.line, undefined, { numeric: true }))
      .slice(0, TOP_LINES),
    topPlaces: [...places.values()]
      .sort((a, b) => b.visits - a.visits || b.ms - a.ms)
      .slice(0, TOP_PLACES)
      .map((p) => ({ name: p.name, kind: p.kind, visits: p.visits, minutes: Math.round(p.ms / 60_000) })),
    newPlaces,
    days: days.map((d) => ({ date: d.date, km: round1(d.m / 1000), movingMinutes: Math.round(d.ms / 60_000) })),
    path: simplifyPath(
      days.flatMap((d) => d.path),
      MAX_PATH_POINTS
    ),
    previous: previous.trips || previous.stops ? { distanceKm: round1(previous.m / 1000), movingMinutes: Math.round(previous.ms / 60_000) } : null,
    empty: sum.trips === 0 && sum.stops === 0,
  };
}

// ---- notifications ----

export function reviewNotificationsOn(userId) {
  return getDb().prepare("SELECT notify FROM review_settings WHERE user_id = ?").get(userId)?.notify !== 0;
}

export function setReviewNotifications(userId, enabled) {
  getDb().prepare("INSERT OR REPLACE INTO review_settings (user_id, notify) VALUES (?, ?)").run(userId, enabled ? 1 : 0);
}

// Which reviews are due at `now`, server time: on Mondays from 09:00 the week before, on the
// first of a month from 09:00 also the month before. A server that was down at nine catches up
// later that day, not after it.
export function duePeriods(now) {
  const local = new Date(now);
  if (local.getHours() < NOTIFY_HOUR) return [];
  const yesterday = addDays(serverZone.today(now), -1);
  const due = [];
  if (local.getDay() === 1) due.push({ period: "week", ...periodOf("week", yesterday) });
  if (local.getDate() === 1) due.push({ period: "month", ...periodOf("month", yesterday) });
  return due;
}

const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const shortDate = (date) => SHORT_DATE.format(parseDate(date));

// "Your week: 84 km, 6 h on the move"
export function reviewPushText(review) {
  const km = review.distanceKm >= 10 ? Math.round(review.distanceKm) : review.distanceKm;
  const minutes = review.movingMinutes;
  const time = minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  return {
    title: `Your ${review.period}: ${km} km, ${time} on the move`,
    body: `Your review of ${shortDate(review.from)} – ${shortDate(review.to)} is ready`,
  };
}

// Sends each due review once per account and period. What went out (or had nothing to say) is
// kept in review_sent, so a restart does not send it again. `push` and `changed` come from the
// app: the Android push and the notificationsChanged message.
export function createReviewJob({ push = () => {}, changed = () => {}, everyMs = JOB_EVERY_MS } = {}) {
  let running = null;

  async function sendDue(now) {
    const db = getDb();
    const sent = db.prepare("SELECT 1 FROM review_sent WHERE user_id = ? AND period = ? AND from_date = ?");
    const mark = db.prepare("INSERT OR REPLACE INTO review_sent (user_id, period, from_date, notified, sent_at) VALUES (?, ?, ?, ?, ?)");
    const told = new Set();
    for (const due of duePeriods(now)) {
      for (const user of listUsers()) {
        if (!reviewNotificationsOn(user.id) || sent.get(user.id, due.period, due.from)) continue;
        const review = await buildReview(user.id, { period: due.period, date: due.from, zone: serverZone, now });
        if (sent.get(user.id, due.period, due.from)) continue;
        mark.run(user.id, due.period, due.from, review.empty ? 0 : 1, new Date(now).toISOString());
        if (review.empty) continue;
        const { period, from, to, distanceKm } = review;
        addNotification(user.id, "review", { period, from, to, distanceKm }, new Date(now));
        push(user.id, { ...reviewPushText(review), data: { type: "review", period, from, to } });
        told.add(user.id);
      }
    }
    if (told.size) changed([...told]);
    return [...told];
  }

  // Resolves with the accounts that were told. A run that is still going is joined, not doubled.
  function run(now = Date.now()) {
    running ??= sendDue(now).finally(() => (running = null));
    return running;
  }

  const timer = setInterval(() => {
    run().catch((error) => console.error(chalk.red(`[!] Review notifications failed: ${error.message}`)));
  }, everyMs);
  timer.unref?.();

  return { run, stop: () => clearInterval(timer) };
}

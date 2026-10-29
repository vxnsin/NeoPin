import { getDb } from "./db.js";
import { getUser, isHidden } from "./accounts.js";
import { isMember, membersOf, sharedGroupIds } from "./groups.js";
import { MAX_ACCURACY_M, distanceM } from "./history.js";
import { listPlaces } from "./places.js";

// Arrival and departure alerts. Each person picks which of their own places count and who
// hears about it: single people, whole groups, or both. Every device of the person keeps its
// own inside/outside state per place, the alerts are per person: two phones coming home
// together make one message, and a tablet that stays at home does not hold the phone back.

// These kinds count until the person saves a choice of their own.
export const DEFAULT_ALERT_KINDS = ["home", "work"];
// A small place would flicker with the GPS, inside counts from this radius at least.
export const MIN_ALERT_RADIUS_M = 60;
// Leaving takes this much more distance, so a fix wobbling at the edge is no departure.
export const LEAVE_MARGIN_M = 50;
// Two fixes inside this far apart are an arrival, a single one may be a walk past.
export const ARRIVE_MS = 2 * 60_000;
// Gone this long after the last fix inside, with two fixes outside, is a departure.
export const LEAVE_MS = 3 * 60_000;
// The same place and direction at most this often, against flapping at the edge.
export const ALERT_COOLDOWN_MS = 10 * 60_000;

const invalid = (message) => Object.assign(new Error(message), { code: "invalid" });
const column = (rows, name) => rows.map((r) => Number(r[name]));

// What a person set up, or the default (home and work, nobody told) while they never saved.
export function alertSettings(userId) {
  const db = getDb();
  const saved = !!db.prepare("SELECT 1 FROM alert_settings WHERE user_id = ?").get(userId);
  const places = saved
    ? column(db.prepare("SELECT place_id FROM alert_places WHERE user_id = ? ORDER BY place_id").all(userId), "place_id")
    : listPlaces(userId)
        .filter((p) => DEFAULT_ALERT_KINDS.includes(p.kind))
        .map((p) => p.id)
        .sort((a, b) => a - b);
  return {
    places,
    recipients: {
      users: column(db.prepare("SELECT recipient_id FROM alert_users WHERE user_id = ? ORDER BY recipient_id").all(userId), "recipient_id"),
      groups: column(db.prepare("SELECT group_id FROM alert_groups WHERE user_id = ? ORDER BY group_id").all(userId), "group_id"),
    },
  };
}

// Replaces the setup. Throws "invalid" for a place that is not the person's own, for someone who
// shares no group with them (themselves included), and for a group they are not in: the same
// people who see them on the map, nobody else.
export function saveAlertSettings(userId, { places, recipients }) {
  const own = new Set(listPlaces(userId).map((p) => p.id));
  const placeIds = [...new Set(places)];
  const userIds = [...new Set(recipients.users)];
  const groupIds = [...new Set(recipients.groups)];
  if (placeIds.some((id) => !own.has(id))) throw invalid("Only your own places can send alerts");
  if (userIds.some((id) => id === userId || sharedGroupIds(userId, id).length === 0)) {
    throw invalid("Alerts only go to people who share a group with you");
  }
  if (groupIds.some((id) => !isMember(id, userId))) throw invalid("Alerts only go to groups you are in");
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR REPLACE INTO alert_settings (user_id, updated_at) VALUES (?, ?)").run(userId, new Date().toISOString());
    for (const table of ["alert_places", "alert_users", "alert_groups"]) db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    const place = db.prepare("INSERT INTO alert_places (user_id, place_id) VALUES (?, ?)");
    for (const id of placeIds) place.run(userId, id);
    const user = db.prepare("INSERT INTO alert_users (user_id, recipient_id) VALUES (?, ?)");
    for (const id of userIds) user.run(userId, id);
    const group = db.prepare("INSERT INTO alert_groups (user_id, group_id) VALUES (?, ?)");
    for (const id of groupIds) group.run(userId, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return alertSettings(userId);
}

// Who hears about the person right now: the chosen people and the members of the chosen groups,
// as long as they still share a group with the person. A group the person left counts no more.
export function alertRecipients(userId) {
  const { recipients } = alertSettings(userId);
  const ids = new Set(recipients.users);
  for (const groupId of recipients.groups) {
    if (!isMember(groupId, userId)) continue;
    for (const member of membersOf(groupId)) ids.add(member);
  }
  ids.delete(userId);
  return [...ids].filter((id) => sharedGroupIds(userId, id).length > 0).sort((a, b) => a - b);
}

// Feeds one fix of a device into the state of the person's alert places. Returns the alerts to
// send: { direction: "arrived" | "left", place, at }. The first change after a place was added
// only learns where the device is, there is nothing to compare it with. While the person is
// hidden the state goes on, nothing is sent.
export function observePresence(userId, deviceId, { lat, lon, ts, accuracy = null }) {
  if (accuracy !== null && accuracy > MAX_ACCURACY_M) return [];
  const chosen = new Set(alertSettings(userId).places);
  if (chosen.size === 0) return [];
  const db = getDb();
  const hidden = isHidden(getUser(userId));
  const alerts = [];
  for (const place of listPlaces(userId).filter((p) => chosen.has(p.id))) {
    const row = db
      .prepare("SELECT * FROM place_presence WHERE user_id = ? AND place_id = ? AND device_id = ?")
      .get(userId, place.id, deviceId);
    // A fix older than what this device already said changes nothing.
    if (row && ts <= Number(row.seen_at)) continue;
    let inside = row?.inside === null || row?.inside === undefined ? null : row.inside === 1;
    let lastInside = row?.last_inside ?? null;
    let pending = row?.pending ?? null;
    let pendingAt = row?.pending_at ?? null;
    let change = null;

    const radius = Math.max(place.radiusM, MIN_ALERT_RADIUS_M);
    const d = distanceM(lat, lon, place.lat, place.lon);
    if (d <= radius) {
      lastInside = ts;
      if (inside === true) pending = null;
      else if (pending === "in" && ts - pendingAt >= ARRIVE_MS) {
        change = inside === null ? null : "arrived";
        inside = true;
        pending = null;
      } else if (pending !== "in") {
        pending = "in";
        pendingAt = ts;
      }
    } else if (d > radius + LEAVE_MARGIN_M) {
      if (inside === false) pending = null;
      else if (pending === "out" && (lastInside === null || ts - lastInside >= LEAVE_MS)) {
        change = inside === null ? null : "left";
        inside = false;
        pending = null;
      } else if (pending !== "out") {
        pending = "out";
        pendingAt = ts;
      }
    }
    // Between the radius and the margin nothing is decided, a started change waits.

    db.prepare(
      `INSERT OR REPLACE INTO place_presence (user_id, place_id, device_id, inside, last_inside, pending, pending_at, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, place.id, deviceId, inside === null ? null : inside ? 1 : 0, lastInside, pending, pendingAt, ts);

    if (!change || hidden) continue;
    const last = db.prepare("SELECT at FROM place_alerts WHERE user_id = ? AND place_id = ? AND direction = ?").get(userId, place.id, change);
    if (last && ts - Number(last.at) < ALERT_COOLDOWN_MS) continue;
    db.prepare("INSERT OR REPLACE INTO place_alerts (user_id, place_id, direction, at) VALUES (?, ?, ?, ?)").run(userId, place.id, change, ts);
    alerts.push({ direction: change, place, at: ts });
  }
  return alerts;
}

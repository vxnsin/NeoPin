import { getDb } from "./db.js";
import { getUser, hiddenSpans, linkedDevices, listUsers, publicUser, spansKeptSince } from "./accounts.js";
import { isMember, sharedGroupIds, visibleUserIds } from "./groups.js";
import { GAP_MS } from "./timeline.js";

// Who may read whose timeline. Nobody shares by default. A person can share with everyone they
// share a group with, or with chosen people and groups. Everybody reads their own, and the admin
// reads all of them. Other people's timelines are for reading only: places, corrections and
// dismissed stops stay with the owner and the admin.

export const SHARING_MODES = ["off", "groups", "selected"];

const invalid = (message) => Object.assign(new Error(message), { code: "invalid" });
const column = (rows, name) => rows.map((r) => Number(r[name]));

// What has a time (a fix's `ts`, a span's `start` and `end`) outside the spans of hiding, for
// whoever reads somebody else's timeline.
export function withoutSpans(items, spans) {
  if (!spans.length) return items;
  return items.filter((item) => {
    const from = item.ts ?? item.start;
    const to = item.ts ?? item.end;
    return !spans.some((s) => from < s.end && to >= s.start);
  });
}

// What others reading the person's timeline do not get between `from` and `to`: the spans of
// hiding, and everything from before the server kept them (see spansKeptSince).
export function hiddenFromOthers(userId, from, to) {
  const since = spansKeptSince();
  const spans = hiddenSpans(userId, from, to);
  return since > from ? [{ start: 0, end: since }, ...spans] : spans;
}

// The trips that border on such a span: without the fixes in it they start or end elsewhere, or
// run across it. What the server stored about the owner's trips (paths, lines) came from all
// fixes, so these get none of it, and nothing about them is stored.
export function bordersOnSpans(spans) {
  if (!spans.length) return () => false;
  return (trip) => spans.some((s) => trip.start < s.end + GAP_MS && trip.end > s.start - GAP_MS);
}

export function timelineSharing(userId) {
  const db = getDb();
  return {
    mode: db.prepare("SELECT mode FROM timeline_sharing WHERE user_id = ?").get(userId)?.mode ?? "off",
    users: column(db.prepare("SELECT viewer_id FROM timeline_share_users WHERE user_id = ? ORDER BY viewer_id").all(userId), "viewer_id"),
    groups: column(db.prepare("SELECT group_id FROM timeline_share_groups WHERE user_id = ? ORDER BY group_id").all(userId), "group_id"),
  };
}

// The chosen people and groups are kept in every mode, so switching back to "selected" finds them
// again. Throws "invalid" for someone who shares no group with the person (themselves included)
// and for a group they are not in.
export function saveTimelineSharing(userId, { mode, users, groups }) {
  const userIds = [...new Set(users)];
  const groupIds = [...new Set(groups)];
  if (userIds.some((id) => id === userId || sharedGroupIds(userId, id).length === 0)) {
    throw invalid("You can only share your timeline with people who share a group with you");
  }
  if (groupIds.some((id) => !isMember(id, userId))) throw invalid("You can only share your timeline with groups you are in");
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR REPLACE INTO timeline_sharing (user_id, mode) VALUES (?, ?)").run(userId, mode);
    db.prepare("DELETE FROM timeline_share_users WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM timeline_share_groups WHERE user_id = ?").run(userId);
    const user = db.prepare("INSERT INTO timeline_share_users (user_id, viewer_id) VALUES (?, ?)");
    for (const id of userIds) user.run(userId, id);
    const group = db.prepare("INSERT INTO timeline_share_groups (user_id, group_id) VALUES (?, ?)");
    for (const id of groupIds) group.run(userId, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return timelineSharing(userId);
}

// Self, the admin, and otherwise only while both still share a group: in "groups" any group, in
// "selected" when the viewer is chosen by name or is in a chosen group the owner is in too.
export function canSeeTimeline(viewer, ownerId) {
  if (!viewer) return false;
  if (viewer.id === ownerId || viewer.is_admin === 1) return true;
  const shared = sharedGroupIds(viewer.id, ownerId);
  if (shared.length === 0) return false;
  const { mode, users, groups } = timelineSharing(ownerId);
  if (mode === "groups") return true;
  if (mode === "selected") return users.includes(viewer.id) || groups.some((id) => shared.includes(id));
  return false;
}

// Everybody whose timeline the viewer may read, the viewer first, then by name.
export function timelinePeople(viewer) {
  const visible = visibleUserIds(viewer);
  const candidates = visible === null ? listUsers() : [...visible].map(getUser).filter(Boolean);
  const name = (u) => u.display_name || u.username;
  const others = candidates
    .filter((u) => u.id !== viewer.id && canSeeTimeline(viewer, u.id))
    .sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: "base" }));
  return [getUser(viewer.id), ...others].map((u) => {
    const { id, displayName, avatarUrl } = publicUser(u);
    return { userId: id, displayName, avatarUrl, devices: linkedDevices(id).map((d) => d.deviceId) };
  });
}

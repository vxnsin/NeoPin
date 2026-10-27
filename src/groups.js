import { getDb } from "./db.js";
import { getUser, getUserByName, publicUser } from "./accounts.js";

// Groups decide who sees whom. A person sees the devices of everyone they share a group with,
// and their own. The admin sees everyone.

const now = () => new Date().toISOString();

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function getGroup(groupId) {
  return getDb().prepare("SELECT * FROM user_groups WHERE id = ?").get(groupId) ?? null;
}

// Puts a new account into every fixed group.
export function joinFixedGroups(userId) {
  getDb()
    .prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) SELECT id, ?, ? FROM user_groups WHERE fixed = 1")
    .run(userId, now());
}

export const isFixed = (group) => group?.fixed === 1;

export function isMember(groupId, userId) {
  return !!getDb().prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, userId);
}

// Whoever owns the group, and the admin, may manage it.
export function canManage(group, user) {
  return !!group && (group.owner_id === user.id || user.is_admin === 1);
}

export function membersOf(groupId) {
  return getDb()
    .prepare("SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at, user_id")
    .all(groupId)
    .map((r) => r.user_id);
}

export function createGroup(ownerId, name) {
  const clean = String(name ?? "").trim().slice(0, 48);
  if (!clean) throw fail("invalid", "The group needs a name");
  const db = getDb();
  const result = db.prepare("INSERT INTO user_groups (name, owner_id, created_at) VALUES (?, ?, ?)").run(clean, ownerId, now());
  const id = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)").run(id, ownerId, now());
  return getGroup(id);
}

export function renameGroup(groupId, name) {
  const clean = String(name ?? "").trim().slice(0, 48);
  if (!clean) throw fail("invalid", "The group needs a name");
  getDb().prepare("UPDATE user_groups SET name = ? WHERE id = ?").run(clean, groupId);
  return getGroup(groupId);
}

// Returns the ids of everyone who was in the group, so they can be told.
export function deleteGroup(groupId) {
  const members = membersOf(groupId);
  const invited = getDb().prepare("SELECT user_id FROM group_invites WHERE group_id = ?").all(groupId).map((r) => r.user_id);
  getDb().prepare("DELETE FROM user_groups WHERE id = ?").run(groupId);
  return [...new Set([...members, ...invited])];
}

// Invites an existing account by username. Throws "notfound", "member" or "invited".
export function invite(groupId, inviterId, username) {
  const target = getUserByName(String(username ?? "").trim());
  if (!target) throw fail("notfound", "No account with that username");
  if (isMember(groupId, target.id)) throw fail("member", `${target.display_name} is already in this group`);
  const existing = getDb().prepare("SELECT id FROM group_invites WHERE group_id = ? AND user_id = ?").get(groupId, target.id);
  if (existing) throw fail("invited", `${target.display_name} has already been invited`);
  getDb()
    .prepare("INSERT INTO group_invites (group_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?)")
    .run(groupId, target.id, inviterId, now());
  return target;
}

export function getInvite(inviteId) {
  return getDb().prepare("SELECT * FROM group_invites WHERE id = ?").get(inviteId) ?? null;
}

export function cancelInvite(inviteId) {
  getDb().prepare("DELETE FROM group_invites WHERE id = ?").run(inviteId);
}

export function acceptInvite(inviteId) {
  const row = getInvite(inviteId);
  getDb().prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)").run(row.group_id, row.user_id, now());
  cancelInvite(inviteId);
  return row;
}

// The owner stays; remove or leave is for the others.
export function removeMember(groupId, userId) {
  getDb().prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, userId);
}

export function invitesFor(userId) {
  return getDb()
    .prepare("SELECT i.id, i.group_id, i.invited_by, i.created_at, g.name FROM group_invites i JOIN user_groups g ON g.id = i.group_id WHERE i.user_id = ? ORDER BY i.id")
    .all(userId)
    .map((r) => {
      const by = getUser(r.invited_by);
      return {
        id: r.id,
        groupId: r.group_id,
        groupName: r.name,
        invitedBy: by ? { id: by.id, username: by.username, displayName: by.display_name } : null,
        createdAt: r.created_at,
      };
    });
}

function memberView(userId, ownerId) {
  const user = publicUser(getUser(userId));
  return { ...user, role: userId === ownerId ? "owner" : "member" };
}

// The groups a person belongs to, with members, and for managers the open invites.
export function groupsFor(user) {
  const db = getDb();
  const rows = db
    .prepare("SELECT g.* FROM user_groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE, g.id")
    .all(user.id);
  return rows.map((g) => {
    const manager = canManage(g, user);
    const pending = manager
      ? db
          .prepare("SELECT id, user_id FROM group_invites WHERE group_id = ? ORDER BY id")
          .all(g.id)
          .map((i) => ({ id: i.id, user: publicUser(getUser(i.user_id)) }))
      : [];
    return {
      id: g.id,
      name: g.name,
      ownerId: g.owner_id,
      role: g.owner_id === user.id ? "owner" : "member",
      canManage: manager,
      fixed: isFixed(g),
      members: membersOf(g.id).map((id) => memberView(id, g.owner_id)),
      pendingInvites: pending,
    };
  });
}

// Which accounts a viewer may see, as a Set. null means everyone (the admin).
export function visibleUserIds(viewer) {
  if (viewer.is_admin === 1) return null;
  const ids = new Set([viewer.id]);
  const rows = getDb()
    .prepare("SELECT DISTINCT m2.user_id AS id FROM group_members m1 JOIN group_members m2 ON m2.group_id = m1.group_id WHERE m1.user_id = ?")
    .all(viewer.id);
  for (const r of rows) ids.add(r.id);
  return ids;
}

// The groups two accounts share, as ids.
export function sharedGroupIds(viewerId, userId) {
  return getDb()
    .prepare("SELECT m1.group_id AS id FROM group_members m1 JOIN group_members m2 ON m2.group_id = m1.group_id WHERE m1.user_id = ? AND m2.user_id = ? ORDER BY m1.group_id")
    .all(viewerId, userId)
    .map((r) => r.id);
}

export function canSee(viewer, userId) {
  const visible = visibleUserIds(viewer);
  return visible === null || visible.has(userId);
}

// Everyone who should be told when this group changes.
export function audience(groupId) {
  const invited = getDb().prepare("SELECT user_id FROM group_invites WHERE group_id = ?").all(groupId).map((r) => r.user_id);
  return [...new Set([...membersOf(groupId), ...invited])];
}

import crypto from "crypto";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { createUser, getUser, publicUser } from "./accounts.js";
import { getGroup, isMember, joinFixedGroups } from "./groups.js";
import { addNotification } from "./notifications.js";

// Invite codes let somebody without an account sign up. Single use, short lived, and the
// account that made one can see who used it.

// Crockford base32: no I, L, O or U, so a code survives being read out or typed from a photo.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;
const NOTE_MAX = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function generateCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

export const groupedCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

// What people type: any case, with spaces or dashes, O for 0 and I or L for 1.
export function normaliseCode(input) {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function inviteStatus(row, now = Date.now()) {
  if (row.revoked_at) return "revoked";
  if (row.used_at) return "used";
  return Date.parse(row.expires_at) <= now ? "expired" : "open";
}

const OPEN = "used_at IS NULL AND revoked_at IS NULL AND expires_at > ?";

function openCount(userId, now) {
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ? AND ${OPEN}`)
    .get(userId, new Date(now).toISOString()).n;
}

// Throws "limit", "unknown-group" or "invalid".
export function createInvite(user, { groupId, note } = {}, now = Date.now()) {
  const cleanNote = String(note ?? "").trim();
  if (cleanNote.length > NOTE_MAX) throw fail("invalid", `The note has at most ${NOTE_MAX} characters`);
  if (user.is_admin !== 1 && openCount(user.id, now) >= config.inviteMaxOpen) {
    throw fail("limit", `You can have ${config.inviteMaxOpen} open invite codes at most`);
  }
  if (groupId !== undefined && groupId !== null) {
    const group = getGroup(groupId);
    if (!group || (user.is_admin !== 1 && !isMember(group.id, user.id))) throw fail("unknown-group", "No such group");
  }
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO invite_codes (code, created_by, group_id, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (;;) {
    try {
      const result = insert.run(
        generateCode(),
        user.id,
        groupId ?? null,
        cleanNote || null,
        new Date(now).toISOString(),
        new Date(now + config.inviteTtlDays * DAY_MS).toISOString()
      );
      return Number(result.lastInsertRowid);
    } catch (error) {
      // A clash with an existing code is astronomically rare, but then try another one.
      if (!/UNIQUE/i.test(error.message)) throw error;
    }
  }
}

const personOf = (id) => {
  const row = id === null ? null : getUser(id);
  if (!row) return null;
  const { username, displayName, avatarUrl } = publicUser(row);
  return { id: row.id, username, displayName, avatarUrl };
};

export function inviteView(row, now = Date.now()) {
  return {
    id: row.id,
    code: groupedCode(row.code),
    status: inviteStatus(row, now),
    note: row.note,
    groupId: row.group_id,
    groupName: row.group_id === null ? null : (getGroup(row.group_id)?.name ?? null),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    createdBy: personOf(row.created_by),
    usedBy: personOf(row.used_by),
    usedAt: row.used_at,
  };
}

export function getInviteCode(id) {
  return getDb().prepare("SELECT * FROM invite_codes WHERE id = ?").get(id) ?? null;
}

// Own codes, the admin gets all of them. Newest first.
export function listInvites(user, now = Date.now()) {
  const db = getDb();
  const rows =
    user.is_admin === 1
      ? db.prepare("SELECT * FROM invite_codes ORDER BY id DESC").all()
      : db.prepare("SELECT * FROM invite_codes WHERE created_by = ? ORDER BY id DESC").all(user.id);
  return rows.map((row) => inviteView(row, now));
}

// Only an open code can be revoked, by whoever made it and by the admin.
export function revokeInvite(user, id, now = Date.now()) {
  const row = getInviteCode(id);
  if (!row || (row.created_by !== user.id && user.is_admin !== 1) || inviteStatus(row, now) !== "open") return false;
  getDb().prepare("UPDATE invite_codes SET revoked_at = ? WHERE id = ?").run(new Date(now).toISOString(), id);
  return true;
}

// The row of a code that can still be used, or null. Unknown, used, expired and revoked look the same.
export function openInviteByCode(input, now = Date.now()) {
  const code = normaliseCode(input);
  if (code.length !== CODE_LENGTH) return null;
  return (
    getDb()
      .prepare(`SELECT * FROM invite_codes WHERE code = ? AND ${OPEN}`)
      .get(code, new Date(now).toISOString()) ?? null
  );
}

// What the sign-up page shows before the person fills in the form.
export function inviteSummary(input, now = Date.now()) {
  const row = openInviteByCode(input, now);
  if (!row) return null;
  return {
    invitedBy: getUser(row.created_by).display_name,
    groupName: row.group_id === null ? null : (getGroup(row.group_id)?.name ?? null),
  };
}

// One transaction: the code is checked, the account created and the code used up, so a failure
// anywhere leaves the code untouched. Throws "invalid-code", or what createUser throws.
// Returns the new account, the code row and who has to be told.
export function registerWithCode(input, { username, password, displayName }, now = Date.now()) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const invite = openInviteByCode(input, now);
    if (!invite) throw fail("invalid-code", "This invite code is not valid");
    const user = createUser({ username, password, displayName });
    joinFixedGroups(user.id);
    const stamp = new Date(now).toISOString();
    const used = db
      .prepare(`UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ? AND ${OPEN}`)
      .run(user.id, stamp, invite.id, stamp);
    if (Number(used.changes) !== 1) throw fail("invalid-code", "This invite code is not valid");
    const group = invite.group_id === null ? null : getGroup(invite.group_id);
    if (group) {
      db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)").run(group.id, user.id, stamp);
    }
    const inviter = getUser(invite.created_by);
    const data = {
      user: personOf(user.id),
      invitedBy: { id: inviter.id, username: inviter.username, displayName: inviter.display_name },
      groupName: group?.name ?? null,
    };
    // The admins and the inviter hear about it, the admin once even when it is the same account.
    const recipients = new Set(db.prepare("SELECT id FROM users WHERE is_admin = 1").all().map((r) => r.id));
    recipients.add(inviter.id);
    for (const id of recipients) addNotification(id, "inviteUsed", data, new Date(now));
    db.exec("COMMIT");
    return { user, invite, group, inviter, recipients: [...recipients] };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

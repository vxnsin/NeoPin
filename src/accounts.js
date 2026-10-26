import crypto from "crypto";
import { config } from "./config.js";
import { getDb } from "./db.js";

// Devices that never announced a type (older app versions) are told apart by their name.
export function inferDeviceType(name) {
  if (/ipad|tablet|\btab\b|\bpad\b/i.test(name ?? "")) return "tablet";
  if (/\b(mac|macbook|imac|laptop|desktop|pc|windows|linux)\b/i.test(name ?? "")) return "desktop";
  return "phone";
}

const USERNAME = /^[A-Za-z0-9_.-]{3,32}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

// Checked against when the user does not exist, so the answer time does not reveal usernames.
const DUMMY_HASH = hashPassword("neopin-dummy");

export const userCount = () => getDb().prepare("SELECT COUNT(*) AS n FROM users").get().n;

// On a fresh database the server creates the admin itself and hands back the
// generated password once. The admin is asked to change it after the first login.
export function ensureAdmin() {
  if (userCount() > 0) return null;
  const generated = !config.adminPassword;
  const password = config.adminPassword ?? crypto.randomBytes(12).toString("base64url");
  const user = createUser({ username: config.adminUsername, password, displayName: "Admin" });
  if (generated) getDb().prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(user.id);
  return { username: user.username, password: generated ? password : null };
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    mustChangePassword: row.must_change_password === 1,
    avatarUrl: row.avatar_b64 ? `/avatars/${row.id}?v=${row.avatar_version}` : null,
  };
}

export function getUser(id) {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null;
}

export function getUserByName(username) {
  return getDb().prepare("SELECT * FROM users WHERE username = ?").get(username) ?? null;
}

export function listUsers() {
  return getDb().prepare("SELECT * FROM users ORDER BY id").all();
}

// Returns the new user row, or throws an Error whose `code` is "invalid" or "taken".
export function createUser({ username, password, displayName }) {
  if (!USERNAME.test(username ?? "")) {
    throw Object.assign(new Error("Username: 3 to 32 letters, digits, dot, dash or underscore"), { code: "invalid" });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    throw Object.assign(new Error("The password needs at least 8 characters"), { code: "invalid" });
  }
  if (getUserByName(username)) throw Object.assign(new Error("Username already taken"), { code: "taken" });
  const name = (displayName ?? "").trim().slice(0, 48) || username;
  // The first account runs the server: it may create and remove the others.
  const admin = userCount() === 0 ? 1 : 0;
  const result = getDb()
    .prepare("INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(username, name, hashPassword(password), admin, new Date().toISOString());
  return getUser(Number(result.lastInsertRowid));
}

export function verifyLogin(username, password) {
  const user = typeof username === "string" ? getUserByName(username) : null;
  const ok = checkPassword(typeof password === "string" ? password : "", user ? user.password_hash : DUMMY_HASH);
  return user && ok ? user : null;
}

export function deleteUser(userId) {
  getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
}

// Devices that logged in with this account, whether they are connected right now or not.
export function linkedDevices(userId) {
  return getDb()
    .prepare("SELECT device_id, created_at, device_type FROM tokens WHERE user_id = ? ORDER BY created_at")
    .all(userId)
    .map((r) => ({ deviceId: r.device_id, linkedAt: r.created_at, deviceType: r.device_type ?? inferDeviceType(r.device_id) }));
}

export function unlinkDevice(userId, deviceId) {
  const result = getDb().prepare("DELETE FROM tokens WHERE user_id = ? AND device_id = ?").run(userId, deviceId);
  return Number(result.changes) > 0;
}

export function setPassword(userId, password) {
  getDb().prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hashPassword(password), userId);
  getDb().prepare("DELETE FROM tokens WHERE user_id = ?").run(userId);
}

// One token per device. Logging in again on the same device replaces it.
export function issueToken(userId, deviceId, deviceType = null) {
  const token = crypto.randomBytes(32).toString("base64url");
  const db = getDb();
  db.prepare("DELETE FROM tokens WHERE user_id = ? AND device_id = ?").run(userId, deviceId);
  db.prepare("INSERT INTO tokens (token_hash, user_id, device_id, created_at, device_type) VALUES (?, ?, ?, ?, ?)").run(
    hashToken(token),
    userId,
    deviceId,
    new Date().toISOString(),
    deviceType
  );
  return token;
}

// The user a token belongs to, only when it was issued for that very device.
export function userForToken(token, deviceId) {
  if (typeof token !== "string" || typeof deviceId !== "string") return null;
  const row = getDb().prepare("SELECT user_id, device_id FROM tokens WHERE token_hash = ?").get(hashToken(token));
  if (!row || row.device_id !== deviceId) return null;
  return getUser(row.user_id);
}

export function revokeToken(token) {
  getDb().prepare("DELETE FROM tokens WHERE token_hash = ?").run(hashToken(token));
}

// The picture is kept as a base64 string right in the user row.
export function setAvatar(userId, data, type) {
  const version = crypto.createHash("sha256").update(data).digest("base64url").slice(0, 12);
  getDb()
    .prepare("UPDATE users SET avatar_b64 = ?, avatar_type = ?, avatar_version = ? WHERE id = ?")
    .run(Buffer.from(data).toString("base64"), type, version, userId);
  return getUser(userId);
}

export function clearAvatar(userId) {
  getDb().prepare("UPDATE users SET avatar_b64 = NULL, avatar_type = NULL, avatar_version = NULL WHERE id = ?").run(userId);
  return getUser(userId);
}

export function avatarFor(userId) {
  const row = getDb().prepare("SELECT avatar_b64, avatar_type FROM users WHERE id = ?").get(userId);
  if (!row?.avatar_b64) return null;
  return { data: Buffer.from(row.avatar_b64, "base64"), type: row.avatar_type };
}

export function avatarUrlFor(userId) {
  return publicUser(getUser(userId))?.avatarUrl ?? null;
}

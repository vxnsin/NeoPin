import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

let db = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_b64 TEXT,
    avatar_type TEXT,
    avatar_version TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS group_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE (group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS positions_lookup ON positions(user_id, device_id, ts);
`;

// ":memory:" gives tests a clean database. Anything else is a file path.
export function initDb(file = config.dbPath) {
  closeDb();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const hadGroups = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_groups'").get();
  db.exec(SCHEMA);
  // Servers from before groups existed: everybody saw everybody, so keep that as one group
  // ("Everyone", owned by the admin) and nothing disappears. Narrow it down from there.
  if (!hadGroups) {
    const admin = db.prepare("SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1").get();
    if (admin) {
      const stamp = new Date().toISOString();
      const group = db.prepare("INSERT INTO user_groups (name, owner_id, created_at) VALUES ('Everyone', ?, ?)").run(admin.id, stamp);
      db.prepare("INSERT INTO group_members (group_id, user_id, joined_at) SELECT ?, id, ? FROM users").run(Number(group.lastInsertRowid), stamp);
    }
  }
  // Databases from before admins existed: the first account becomes the admin.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "is_admin")) {
    db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)");
  }
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "must_change_password")) {
    db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  }
  if (!db.prepare("PRAGMA table_info(tokens)").all().some((c) => c.name === "device_type")) {
    db.exec("ALTER TABLE tokens ADD COLUMN device_type TEXT");
  }
  return db;
}

export function getDb() {
  return db ?? initDb();
}

export function closeDb() {
  db?.close();
  db = null;
}

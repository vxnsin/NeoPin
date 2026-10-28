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
    fixed INTEGER NOT NULL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'place',
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    radius_m INTEGER NOT NULL DEFAULT 60,
    osm_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS places_user ON places(user_id);
  CREATE TABLE IF NOT EXISTS place_cache (
    cell TEXT PRIMARY KEY,
    fetched_at INTEGER NOT NULL,
    candidates TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transit_regions (
    cell TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transit_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cell TEXT NOT NULL,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT,
    url TEXT NOT NULL,
    license TEXT,
    updated_at INTEGER,
    stops INTEGER NOT NULL DEFAULT 0,
    routes INTEGER NOT NULL DEFAULT 0,
    trips INTEGER NOT NULL DEFAULT 0,
    UNIQUE (cell, source)
  );
  CREATE TABLE IF NOT EXISTS transit_stops (
    feed_id INTEGER NOT NULL REFERENCES transit_feeds(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    PRIMARY KEY (feed_id, id)
  );
  CREATE INDEX IF NOT EXISTS transit_stops_at ON transit_stops(lat, lon);
  CREATE TABLE IF NOT EXISTS transit_routes (
    feed_id INTEGER NOT NULL REFERENCES transit_feeds(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    short_name TEXT,
    long_name TEXT,
    type INTEGER NOT NULL,
    color TEXT,
    text_color TEXT,
    agency TEXT,
    timezone TEXT,
    PRIMARY KEY (feed_id, id)
  );
  CREATE TABLE IF NOT EXISTS transit_trips (
    feed_id INTEGER NOT NULL REFERENCES transit_feeds(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    headsign TEXT,
    shape_id TEXT,
    PRIMARY KEY (feed_id, id)
  );
  CREATE TABLE IF NOT EXISTS transit_stop_times (
    feed_id INTEGER NOT NULL REFERENCES transit_feeds(id) ON DELETE CASCADE,
    trip_id TEXT NOT NULL,
    stop_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    departure INTEGER,
    PRIMARY KEY (feed_id, trip_id, seq)
  );
  CREATE INDEX IF NOT EXISTS transit_stop_times_stop ON transit_stop_times(feed_id, stop_id);
  CREATE TABLE IF NOT EXISTS transit_shapes (
    feed_id INTEGER NOT NULL REFERENCES transit_feeds(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    PRIMARY KEY (feed_id, id, seq)
  );
  CREATE TABLE IF NOT EXISTS transit_osm_cache (
    cell TEXT PRIMARY KEY,
    fetched_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trip_transit (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    transit TEXT,
    data_stamp INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, start)
  );
  CREATE TABLE IF NOT EXISTS trip_modes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    mode TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id, start)
  );
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
  // A fixed group holds every account: nobody leaves it, nobody is removed, it is not deleted.
  const hadFixed = db.prepare("PRAGMA table_info(user_groups)").all().some((c) => c.name === "fixed");
  if (!hadFixed) {
    db.exec("ALTER TABLE user_groups ADD COLUMN fixed INTEGER NOT NULL DEFAULT 0");
    // The "Everyone" group that servers from before groups got is that group.
    db.exec("UPDATE user_groups SET fixed = 1 WHERE id = (SELECT MIN(id) FROM user_groups WHERE name = 'Everyone')");
  }
  // Servers from before groups existed: everybody saw everybody, so keep that as one group
  // ("Everyone", owned by the admin) and nothing disappears. Narrow it down from there.
  if (!hadGroups) {
    const admin = db.prepare("SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1").get();
    if (admin) {
      const stamp = new Date().toISOString();
      const group = db
        .prepare("INSERT INTO user_groups (name, owner_id, fixed, created_at) VALUES ('Everyone', ?, 1, ?)")
        .run(admin.id, stamp);
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
  // How exact a stored fix is and how fast the phone moved, both straight from its GPS.
  const positionColumns = db.prepare("PRAGMA table_info(positions)").all().map((c) => c.name);
  if (!positionColumns.includes("accuracy")) db.exec("ALTER TABLE positions ADD COLUMN accuracy REAL");
  if (!positionColumns.includes("speed")) db.exec("ALTER TABLE positions ADD COLUMN speed REAL");
  // Until when the account hides its devices from everyone else, ms since the epoch. NULL is visible.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "hidden_until")) {
    db.exec("ALTER TABLE users ADD COLUMN hidden_until INTEGER");
  }
  // Everybody is in the fixed groups, also those removed before groups could be fixed.
  db.prepare(
    "INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) SELECT g.id, u.id, ? FROM user_groups g, users u WHERE g.fixed = 1"
  ).run(new Date().toISOString());
  // The device a person picked to stand for them, NULL for the automatic choice.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "primary_device_id")) {
    db.exec("ALTER TABLE users ADD COLUMN primary_device_id TEXT");
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

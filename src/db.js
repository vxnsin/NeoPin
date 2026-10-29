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
  CREATE TABLE IF NOT EXISTS device_battery (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    level REAL NOT NULL,
    charging INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS push_tokens (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    token TEXT NOT NULL,
    platform TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id)
  );
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
    path TEXT,
    data_stamp INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, start)
  );
  CREATE TABLE IF NOT EXISTS trip_paths (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    profile TEXT NOT NULL,
    path TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, start, profile)
  );
  CREATE TABLE IF NOT EXISTS trip_modes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    mode TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id, start)
  );
  CREATE TABLE IF NOT EXISTS ride_answers (
    ride_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    boarded_at INTEGER NOT NULL,
    line TEXT NOT NULL,
    transit TEXT NOT NULL,
    feed_id INTEGER,
    trip_id TEXT,
    from_seq INTEGER,
    asked_at INTEGER NOT NULL,
    answer TEXT,
    answered_at INTEGER,
    UNIQUE (user_id, device_id, boarded_at)
  );
  CREATE TABLE IF NOT EXISTS dismissed_visits (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, start)
  );
  CREATE TABLE IF NOT EXISTS timeline_sharing (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS timeline_share_users (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, viewer_id)
  );
  CREATE TABLE IF NOT EXISTS timeline_share_groups (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
  );
  CREATE TABLE IF NOT EXISTS hidden_spans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start INTEGER NOT NULL,
    end_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS hidden_spans_user ON hidden_spans(user_id, start);
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES user_groups(id) ON DELETE SET NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS invite_codes_creator ON invite_codes(created_by);
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);
  CREATE TABLE IF NOT EXISTS alert_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alert_places (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, place_id)
  );
  CREATE TABLE IF NOT EXISTS alert_users (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, recipient_id)
  );
  CREATE TABLE IF NOT EXISTS alert_groups (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
  );
  CREATE TABLE IF NOT EXISTS place_presence (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    inside INTEGER,
    last_inside INTEGER,
    pending TEXT,
    pending_at INTEGER,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, place_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS place_alerts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, place_id, direction)
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
  const hadSpans = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hidden_spans'").get();
  db.exec(SCHEMA);
  // Servers from before the spans: whoever hides right now is hidden from now on, when it began is unknown.
  const hasHidden = db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "hidden_until");
  if (!hadSpans && hasHidden) {
    const now = Date.now();
    db.prepare("INSERT INTO hidden_spans (user_id, start, end_ms) SELECT id, ?, hidden_until FROM users WHERE hidden_until > ?").run(now, now);
  }
  // Nobody knows who was invisible before the spans were kept, so whatever was recorded until then
  // stays with the owner and the admin. A database without any fixes yet has nothing to hide.
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'hidden_spans_since'").get()) {
    const recorded = !!db.prepare("SELECT 1 FROM positions LIMIT 1").get();
    db.prepare("INSERT INTO meta (key, value) VALUES ('hidden_spans_since', ?)").run(String(recorded ? Date.now() : 0));
  }
  // Groups used to be fixed (one held every account for good). None is any more: an old
  // "Everyone" group stays with its members as a normal group. The column stays for older apps.
  if (!db.prepare("PRAGMA table_info(user_groups)").all().some((c) => c.name === "fixed")) {
    db.exec("ALTER TABLE user_groups ADD COLUMN fixed INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("UPDATE user_groups SET fixed = 0 WHERE fixed <> 0");
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
  // How exact a stored fix is and how fast the phone moved, both straight from its GPS.
  const positionColumns = db.prepare("PRAGMA table_info(positions)").all().map((c) => c.name);
  if (!positionColumns.includes("accuracy")) db.exec("ALTER TABLE positions ADD COLUMN accuracy REAL");
  if (!positionColumns.includes("speed")) db.exec("ALTER TABLE positions ADD COLUMN speed REAL");
  // Until when the account hides its devices from everyone else, ms since the epoch. NULL is visible.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "hidden_until")) {
    db.exec("ALTER TABLE users ADD COLUMN hidden_until INTEGER");
  }
  // The course of a recognised line between the stops, next to the match itself.
  if (!db.prepare("PRAGMA table_info(trip_transit)").all().some((c) => c.name === "path")) {
    db.exec("ALTER TABLE trip_transit ADD COLUMN path TEXT");
  }
  // The device a person picked to stand for them, NULL for the automatic choice.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "primary_device_id")) {
    db.exec("ALTER TABLE users ADD COLUMN primary_device_id TEXT");
  }
  // Which snapping version made a stored path; older rows are matched again (see paths.js).
  if (!db.prepare("PRAGMA table_info(trip_paths)").all().some((c) => c.name === "algo")) {
    db.exec("ALTER TABLE trip_paths ADD COLUMN algo INTEGER NOT NULL DEFAULT 1");
  }
  // When the account went through the short tour of the app and of the dashboard, NULL for not yet.
  // Whoever had an account before the tours existed knows their way around already.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "tour_app_at")) {
    db.exec("ALTER TABLE users ADD COLUMN tour_app_at TEXT");
    db.exec("ALTER TABLE users ADD COLUMN tour_dashboard_at TEXT");
    const stamp = new Date().toISOString();
    db.prepare("UPDATE users SET tour_app_at = ?, tour_dashboard_at = ?").run(stamp, stamp);
    // Same for the server: one with groups or with more than the admin is set up already.
    const used = db.prepare("SELECT 1 FROM user_groups LIMIT 1").get() || db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 1;
    if (used) db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('setup_done', ?)").run(stamp);
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

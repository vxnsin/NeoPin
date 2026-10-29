import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "./helpers.js";
import { config } from "../src/config.js";
import { closeDb, getDb, initDb } from "../src/db.js";
import {
  applyStagedRestore,
  backupDir,
  backupDue,
  backupFile,
  backupName,
  beforeRestoreFile,
  listBackups,
  msUntilNightly,
  restorePending,
  runBackup,
  stagedRestoreFile,
} from "../src/backups.js";

const originalDbPath = config.dbPath;
const originalKeep = config.backupKeep;
let s;
let dir;

// Backups copy a real file, so these tests run on one in a temporary folder.
test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "neopin-backups-test-"));
  config.dbPath = path.join(dir, "neopin.db");
  s = await startServer();
  initDb(config.dbPath);
});

test.afterEach(async () => {
  await s.stop();
  config.dbPath = originalDbPath;
  config.backupKeep = originalKeep;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const get = (route, cookie) => fetch(s.baseUrl + route, { headers: cookie ? { cookie } : {} });
const upload = (body, cookie, type = "application/octet-stream") =>
  fetch(`${s.baseUrl}/api/admin/restore`, { method: "POST", headers: { cookie, "content-type": type }, body });

// A small NeoPin database of its own, as a file's bytes.
function otherDatabase(username) {
  const file = path.join(dir, `${username}.db`);
  const db = initDb(file);
  db.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, 'x', 'now')").run(username, username);
  // Back to the server's own database, which is a file and keeps what it had.
  initDb(config.dbPath);
  return fs.readFileSync(file);
}

test("the admin downloads a consistent copy without the timetables", async () => {
  const admin = await s.account("boss");
  const other = await s.account("luis");
  getDb().prepare("INSERT INTO transit_regions (cell, seen_at) VALUES ('1:1', 1)").run();

  assert.equal((await get("/api/admin/backup")).status, 401);
  assert.equal((await get("/api/admin/backup", other.cookie)).status, 403);

  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("neopin-backup-")).length;
  const before = leftovers();
  const res = await get("/api/admin/backup", admin.cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="${backupName()}"`);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get("content-length")), bytes.length);
  assert.equal(bytes.subarray(0, 15).toString("latin1"), "SQLite format 3");

  const file = path.join(dir, "download.db");
  fs.writeFileSync(file, bytes);
  const copy = new DatabaseSync(file);
  assert.deepEqual(copy.prepare("SELECT username FROM users ORDER BY id").all().map((r) => r.username), ["boss", "luis"]);
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM transit_regions").get().n, 0);
  copy.close();
  // Nothing of the download stays behind in the temporary folder.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(leftovers(), before);
});

test("nightly backups land in backups/ and only the newest BACKUP_KEEP stay", async () => {
  await s.account("boss");
  config.backupKeep = 3;
  assert.equal(backupDue(), true);
  for (let day = 1; day <= 5; day++) await runBackup(new Date(2026, 9, day, 3, 30));
  // A second run on the same day replaces that day's file.
  const { removed } = await runBackup(new Date(2026, 9, 5, 12, 0));
  assert.deepEqual(removed, []);
  const names = listBackups().map((b) => b.name);
  assert.deepEqual(names, ["neopin-2026-10-05.db", "neopin-2026-10-04.db", "neopin-2026-10-03.db"]);
  assert.equal(path.dirname(backupFile(names[0])), path.join(dir, "backups"));
  assert.equal(backupDue(), false);
  // No temporary files are left over.
  assert.deepEqual(fs.readdirSync(backupDir()).sort(), [...names].sort());
});

test("the next nightly run is at 03:30 server time", () => {
  assert.equal(msUntilNightly(new Date(2026, 9, 29, 3, 0)), 30 * 60_000);
  assert.equal(msUntilNightly(new Date(2026, 9, 29, 3, 30)), 24 * 3_600_000);
  assert.equal(msUntilNightly(new Date(2026, 9, 29, 23, 30)), 4 * 3_600_000);
});

test("kept backups are listed and downloaded by their exact name only", async () => {
  const admin = await s.account("boss");
  const other = await s.account("luis");
  await runBackup(new Date(2026, 9, 28));
  fs.writeFileSync(path.join(dir, "secret.db"), "no");

  assert.equal((await get("/api/admin/backups", other.cookie)).status, 403);
  const list = await (await get("/api/admin/backups", admin.cookie)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "neopin-2026-10-28.db");
  assert.ok(list[0].size > 0);
  assert.ok(!Number.isNaN(Date.parse(list[0].createdAt)));

  const res = await get("/api/admin/backups/neopin-2026-10-28.db", admin.cookie);
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, list[0].size);
  assert.equal((await get("/api/admin/backups/neopin-2026-10-28.db", other.cookie)).status, 403);

  for (const name of ["neopin-2026-10-27.db", "..%2Fsecret.db", "%2E%2E%2Fneopin.db", "neopin.db", "neopin-2026-10-28.db.tmp", "neopin-26-10-28.db"]) {
    assert.equal((await get(`/api/admin/backups/${name}`, admin.cookie)).status, 404, name);
  }
  for (const name of ["../secret.db", "neopin-2026-10-28.db/../../secret.db", "/etc/passwd", "", null]) {
    assert.equal(backupFile(name), null, String(name));
  }
});

test("a restore is checked, staged and only swapped in on the next start", async () => {
  const admin = await s.account("boss");
  const other = await s.account("luis");
  const good = otherDatabase("restored");

  assert.equal((await upload(good, other.cookie)).status, 403);
  assert.equal((await upload(good, admin.cookie, "application/json")).status, 415);
  for (const bad of [Buffer.from("hello"), Buffer.alloc(4096), Buffer.concat([good.subarray(0, 100), Buffer.alloc(good.length - 100)])]) {
    const res = await upload(bad, admin.cookie);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).type.endsWith("invalid-backup"), true);
  }
  // A SQLite database that is no NeoPin one.
  const foreign = new DatabaseSync(path.join(dir, "foreign.db"));
  foreign.exec("CREATE TABLE notes (text TEXT)");
  foreign.close();
  assert.equal((await upload(fs.readFileSync(path.join(dir, "foreign.db")), admin.cookie)).status, 400);
  assert.equal(restorePending(), false);
  assert.equal(fs.readdirSync(dir).some((n) => n.endsWith(".tmp")), false);

  const res = await upload(good, admin.cookie);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { message: "Restart the server to finish." });
  assert.equal(restorePending(), true);
  // The running server keeps its database until then.
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM users").get().n, 2);

  // The next start: the database is closed, the staged one takes its place.
  closeDb();
  assert.equal(applyStagedRestore(), true);
  assert.equal(fs.existsSync(stagedRestoreFile()), false);
  assert.equal(fs.existsSync(`${config.dbPath}-wal`), false);
  const db = initDb(config.dbPath);
  assert.deepEqual(db.prepare("SELECT username FROM users").all().map((r) => r.username), ["restored"]);
  // The old one is kept as it was.
  const before = new DatabaseSync(beforeRestoreFile());
  assert.deepEqual(before.prepare("SELECT username FROM users ORDER BY id").all().map((r) => r.username), ["boss", "luis"]);
  before.close();
  assert.equal(applyStagedRestore(), false, "nothing staged any more");
});

test("a downloaded backup can be restored as it is", async () => {
  const admin = await s.account("boss");
  const bytes = Buffer.from(await (await get("/api/admin/backup", admin.cookie)).arrayBuffer());
  await s.account("later");
  assert.equal((await upload(bytes, admin.cookie)).status, 202);
  closeDb();
  applyStagedRestore();
  assert.deepEqual(initDb(config.dbPath).prepare("SELECT username FROM users").all().map((r) => r.username), ["boss"]);
});

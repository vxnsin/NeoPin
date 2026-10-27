import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HIDDEN_FOREVER } from "../src/accounts.js";
import { closeDb, getDb, initDb } from "../src/db.js";
import { startServer } from "./helpers.js";

let s;
beforeEach(async () => {
  s = await startServer();
});
afterEach(() => s.stop());

const call = (method, route, body, cookie) =>
  fetch(s.baseUrl + route, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (res) => res.json();
const seenBy = async (user) =>
  (await json(await call("GET", "/api/getData", undefined, user.cookie))).map((d) => d.owner.username).sort();

// An "Everyone" group like the one servers from before groups got, fixed.
function everyone(owner, ...members) {
  const db = getDb();
  const stamp = new Date().toISOString();
  const id = Number(db.prepare("INSERT INTO user_groups (name, owner_id, fixed, created_at) VALUES ('Everyone', ?, 1, ?)").run(owner.user.id, stamp).lastInsertRowid);
  for (const m of [owner, ...members]) db.prepare("INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)").run(id, m.user.id, stamp);
  return id;
}

test("an older database marks its Everyone group as fixed and puts everybody back in", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "neopin-")), "groups.db");
  initDb(file);
  const db = getDb();
  db.exec("INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES ('boss','Boss','x',1,'2025'),('anna','Anna','x',0,'2025')");
  db.exec("INSERT INTO user_groups (name, owner_id, created_at) VALUES ('Everyone', 1, '2025'), ('Family', 1, '2025')");
  db.exec("INSERT INTO group_members (group_id, user_id, joined_at) VALUES (1, 1, '2025'), (2, 1, '2025')");
  closeDb();
  // Back to how it looked before groups could be fixed.
  const old = new DatabaseSync(file);
  old.exec("ALTER TABLE user_groups DROP COLUMN fixed");
  old.close();

  const reopened = initDb(file);
  const fixed = reopened.prepare("SELECT name, fixed FROM user_groups ORDER BY id").all().map((g) => [g.name, g.fixed]);
  assert.deepEqual(fixed, [
    ["Everyone", 1],
    ["Family", 0],
  ]);
  const inEveryone = reopened.prepare("SELECT user_id FROM group_members WHERE group_id = 1 ORDER BY user_id").all().map((r) => r.user_id);
  assert.deepEqual(inEveryone, [1, 2], "anna is back in Everyone, Family stays as it was");
});

test("nobody leaves the fixed group, nobody is removed, it is not deleted", async () => {
  const boss = await s.account("boss");
  const anna = await s.account("anna");
  const id = everyone(boss, anna);

  const groups = await json(await call("GET", "/api/groups", undefined, anna.cookie));
  assert.equal(groups.find((g) => g.id === id).fixed, true);

  assert.equal((await call("DELETE", `/api/groups/${id}/members/${anna.user.id}`, undefined, anna.cookie)).status, 403, "leaving");
  assert.equal((await call("DELETE", `/api/groups/${id}/members/${anna.user.id}`, undefined, boss.cookie)).status, 403, "removing");
  assert.equal((await call("DELETE", `/api/groups/${id}`, undefined, boss.cookie)).status, 403, "deleting");
  assert.equal((await call("PATCH", `/api/groups/${id}`, { name: "All of us" }, boss.cookie)).status, 200, "renaming is fine");
});

test("a new account joins the fixed group right away", async () => {
  const boss = await s.account("boss");
  const id = everyone(boss);
  const created = await call("POST", "/api/users", { username: "tom", password: "correct-horse" }, boss.cookie);
  assert.equal(created.status, 201);
  const tom = await created.json();
  assert.ok(getDb().prepare("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?").get(id, tom.id));
});

test("someone who hides is gone from everyone else's map for a while, the admin included", async () => {
  const boss = await s.account("boss");
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  everyone(boss, luis, anna);
  assert.deepEqual(await seenBy(luis), ["anna", "boss", "luis"]);

  const before = Date.now();
  const hidden = await json(await call("PUT", "/api/me/hidden", { minutes: 15 }, anna.cookie));
  assert.ok(hidden.hiddenUntil >= before + 15 * 60_000 && hidden.hiddenUntil <= Date.now() + 15 * 60_000);

  assert.deepEqual(await seenBy(luis), ["boss", "luis"]);
  assert.deepEqual(await seenBy(boss), ["boss", "luis"]);
  assert.deepEqual(await seenBy(anna), ["anna", "boss", "luis"], "anna still sees herself");

  const shown = await json(await call("DELETE", "/api/me/hidden", undefined, anna.cookie));
  assert.equal(shown.hiddenUntil, null);
  assert.deepEqual(await seenBy(luis), ["anna", "boss", "luis"]);
});

test("hiding until turned off lasts, a hiding that ran out shows the person again", async () => {
  const boss = await s.account("boss");
  const anna = await s.account("anna");
  everyone(boss, anna);

  const forever = await json(await call("PUT", "/api/me/hidden", {}, anna.cookie));
  assert.equal(forever.hiddenUntil, HIDDEN_FOREVER);
  assert.equal((await json(await call("GET", "/api/me", undefined, anna.cookie))).hiddenUntil, HIDDEN_FOREVER);
  assert.deepEqual(await seenBy(boss), ["boss"]);

  getDb().prepare("UPDATE users SET hidden_until = ? WHERE id = ?").run(Date.now() - 1000, anna.user.id);
  assert.deepEqual(await seenBy(boss), ["anna", "boss"]);
  assert.equal((await json(await call("GET", "/api/me", undefined, anna.cookie))).hiddenUntil, null);
});

test("hiding takes a few minutes up to a week", async () => {
  const anna = await s.account("anna");
  assert.equal((await call("PUT", "/api/me/hidden", { minutes: 0 }, anna.cookie)).status, 400);
  assert.equal((await call("PUT", "/api/me/hidden", { minutes: 7 * 24 * 60 + 1 }, anna.cookie)).status, 400);
});

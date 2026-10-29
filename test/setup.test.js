import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDb, getDb, initDb } from "../src/db.js";
import { PASSWORD, startServer } from "./helpers.js";

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
const me = async (who) => json(await call("GET", "/api/me", undefined, who.cookie));
const groupsOf = (userId) =>
  getDb().prepare("SELECT group_id AS id FROM group_members WHERE user_id = ? ORDER BY group_id").all(userId).map((r) => r.id);

test("an older database: the fixed group turns normal, accounts know the tours, the server is set up", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "neopin-")), "old.db");
  initDb(file);
  const db = getDb();
  db.exec("INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES ('boss','Boss','x',1,'2025'),('anna','Anna','x',0,'2025')");
  db.exec("INSERT INTO user_groups (name, owner_id, fixed, created_at) VALUES ('Everyone', 1, 1, '2025'), ('Family', 1, 0, '2025')");
  db.exec("INSERT INTO group_members (group_id, user_id, joined_at) VALUES (1, 1, '2025'), (2, 1, '2025')");
  closeDb();
  // Back to how it looked before the tours.
  const old = new DatabaseSync(file);
  old.exec("ALTER TABLE users DROP COLUMN tour_app_at; ALTER TABLE users DROP COLUMN tour_dashboard_at; DELETE FROM meta WHERE key = 'setup_done'");
  old.close();

  const reopened = initDb(file);
  assert.deepEqual(reopened.prepare("SELECT fixed FROM user_groups ORDER BY id").all().map((g) => g.fixed), [0, 0]);
  const inEveryone = reopened.prepare("SELECT user_id FROM group_members WHERE group_id = 1").all().map((r) => r.user_id);
  assert.deepEqual(inEveryone, [1], "nobody is put back into Everyone");
  const unseen = reopened.prepare("SELECT COUNT(*) AS n FROM users WHERE tour_app_at IS NULL OR tour_dashboard_at IS NULL").get().n;
  assert.equal(unseen, 0);
  assert.ok(reopened.prepare("SELECT 1 FROM meta WHERE key = 'setup_done'").get());
});

test("a new server: the admin has a setup and both tours ahead, a new account only the tours", async () => {
  const boss = await s.account("boss");
  const anna = await s.account("anna");
  const mine = await me(boss);
  assert.equal(mine.setupNeeded, true);
  assert.deepEqual(mine.tours, { app: false, dashboard: false });
  const hers = await me(anna);
  assert.equal("setupNeeded" in hers, false, "only the admin is told about the setup");
  assert.deepEqual(hers.tours, { app: false, dashboard: false });
  assert.deepEqual(groupsOf(anna.user.id), [], "no group to start with");
});

test("a tour is marked as seen per client, and only for that account", async () => {
  const boss = await s.account("boss");
  const anna = await s.account("anna");
  assert.equal((await call("POST", "/api/me/tours", { client: "dashboard" }, anna.cookie)).status, 204);
  assert.deepEqual((await me(anna)).tours, { app: false, dashboard: true });
  const app = await fetch(s.baseUrl + "/api/me/tours", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${encodeURIComponent(anna.token)}`, "x-device-id": "phone" },
    body: JSON.stringify({ client: "app" }),
  });
  assert.equal(app.status, 204, "the app says so with its token");
  assert.deepEqual((await me(anna)).tours, { app: true, dashboard: true });
  assert.deepEqual((await me(boss)).tours, { app: false, dashboard: false });
  assert.equal((await call("POST", "/api/me/tours", { client: "watch" }, anna.cookie)).status, 400);
});

test("the setup ends only for the admin and only once the admin is in a group", async () => {
  const boss = await s.account("boss");
  const anna = await s.account("anna");
  assert.equal((await call("POST", "/api/setup/done", undefined, anna.cookie)).status, 403);
  const early = await call("POST", "/api/setup/done", undefined, boss.cookie);
  assert.equal(early.status, 409);
  assert.equal((await early.json()).type, "no-group");
  assert.equal((await me(boss)).setupNeeded, true);

  assert.equal((await call("POST", "/api/groups", { name: "Family" }, boss.cookie)).status, 201);
  assert.equal((await call("POST", "/api/setup/done", undefined, boss.cookie)).status, 204);
  assert.equal((await me(boss)).setupNeeded, false);
  assert.equal((await call("POST", "/api/setup/done", undefined, boss.cookie)).status, 204, "again is fine");
});

test("a group called Everyone is a normal group: leave, remove, delete", async () => {
  const boss = await s.account("boss");
  const anna = await s.account("anna");
  const tom = await s.account("tom");
  const group = await json(await call("POST", "/api/groups", { name: "Everyone" }, boss.cookie));
  getDb().prepare("UPDATE user_groups SET fixed = 1 WHERE id = ?").run(group.id);
  for (const who of [anna, tom]) getDb().prepare("INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, '2025')").run(group.id, who.user.id);

  const listed = (await json(await call("GET", "/api/groups", undefined, anna.cookie))).find((g) => g.id === group.id);
  assert.equal(listed.fixed, false, "older apps still get the field");
  assert.equal((await call("DELETE", `/api/groups/${group.id}/members/${anna.user.id}`, undefined, anna.cookie)).status, 204, "leaving");
  assert.equal((await call("DELETE", `/api/groups/${group.id}/members/${tom.user.id}`, undefined, boss.cookie)).status, 204, "removing");
  assert.equal((await call("DELETE", `/api/groups/${group.id}`, undefined, boss.cookie)).status, 204, "deleting");
});

test("the admin creates an account straight into groups, or into none", async () => {
  const boss = await s.account("boss");
  const family = await json(await call("POST", "/api/groups", { name: "Family" }, boss.cookie));
  const friends = await json(await call("POST", "/api/groups", { name: "Friends" }, boss.cookie));

  const created = await call("POST", "/api/users", { username: "tom", password: PASSWORD, groupIds: [family.id, friends.id, family.id] }, boss.cookie);
  assert.equal(created.status, 201);
  const tom = await created.json();
  assert.deepEqual(groupsOf(tom.id), [family.id, friends.id]);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM group_invites").get().n, 0, "no invite to accept");

  const alone = await json(await call("POST", "/api/users", { username: "anna", password: PASSWORD }, boss.cookie));
  assert.deepEqual(groupsOf(alone.id), []);

  const wrong = await call("POST", "/api/users", { username: "max", password: PASSWORD, groupIds: [family.id, 9999] }, boss.cookie);
  assert.equal(wrong.status, 400);
  assert.equal(getDb().prepare("SELECT 1 FROM users WHERE username = 'max'").get(), undefined, "no account is left behind");
});

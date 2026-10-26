import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initDb } from "../src/db.js";
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

async function people() {
  const admin = await s.account("boss"); // the first account is the admin
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const tom = await s.account("tom");
  return { admin, luis, anna, tom };
}

async function newGroup(owner, name = "Family") {
  return json(await call("POST", "/api/groups", { name }, owner.cookie));
}

async function join(group, owner, member) {
  await call("POST", "/api/groups/" + group.id + "/invites", { username: member.user.username }, owner.cookie);
  const invites = await json(await call("GET", "/api/invites", undefined, member.cookie));
  const invite = invites.find((i) => i.groupId === group.id);
  assert.equal((await call("POST", "/api/invites/" + invite.id + "/accept", undefined, member.cookie)).status, 204);
}

test("a group is created by anyone and the creator owns it", async () => {
  const { luis } = await people();
  const res = await call("POST", "/api/groups", { name: "  Family  " }, luis.cookie);
  assert.equal(res.status, 201);
  const group = await json(res);
  assert.equal(group.name, "Family");
  assert.equal(group.role, "owner");
  assert.deepEqual(group.members.map((m) => [m.username, m.role]), [["luis", "owner"]]);
  assert.equal((await call("POST", "/api/groups", { name: "  " }, luis.cookie)).status, 400);
  assert.equal((await call("POST", "/api/groups", { name: "x" })).status, 401);
});

test("an invite is accepted or declined by the invited person", async () => {
  const { luis, anna, tom } = await people();
  const group = await newGroup(luis);
  const invite = (username, cookie) => call("POST", "/api/groups/" + group.id + "/invites", { username }, cookie);

  assert.equal((await invite("nobody", luis.cookie)).status, 404);
  assert.equal((await invite("anna", anna.cookie)).status, 404, "outsiders do not know the group");
  assert.equal((await invite("anna", luis.cookie)).status, 201);
  assert.equal((await invite("anna", luis.cookie)).status, 409, "already invited");
  assert.equal((await invite("luis", luis.cookie)).status, 409, "already a member");

  const invites = await json(await call("GET", "/api/invites", undefined, anna.cookie));
  assert.equal(invites.length, 1);
  assert.equal(invites[0].groupName, "Family");
  assert.equal(invites[0].invitedBy.username, "luis");

  const mine = await json(await call("GET", "/api/groups", undefined, luis.cookie));
  assert.equal(mine[0].pendingInvites[0].user.username, "anna");

  assert.equal((await call("POST", "/api/invites/" + invites[0].id + "/accept", undefined, tom.cookie)).status, 404, "somebody else's invite");
  assert.equal((await call("POST", "/api/invites/" + invites[0].id + "/accept", undefined, anna.cookie)).status, 204);
  const after = await json(await call("GET", "/api/groups", undefined, anna.cookie));
  assert.deepEqual(after[0].members.map((m) => m.username).sort(), ["anna", "luis"]);
  assert.equal(after[0].role, "member");
  assert.deepEqual(after[0].pendingInvites, [], "members do not see open invites");

  await invite("tom", luis.cookie);
  const tomInvite = (await json(await call("GET", "/api/invites", undefined, tom.cookie)))[0];
  assert.equal((await call("POST", "/api/invites/" + tomInvite.id + "/decline", undefined, tom.cookie)).status, 204);
  assert.deepEqual(await json(await call("GET", "/api/groups", undefined, tom.cookie)), []);
});

test("an owner can take an invite back", async () => {
  const { luis, anna } = await people();
  const group = await newGroup(luis);
  await call("POST", "/api/groups/" + group.id + "/invites", { username: "anna" }, luis.cookie);
  const open = (await json(await call("GET", "/api/groups", undefined, luis.cookie)))[0].pendingInvites[0];
  assert.equal((await call("DELETE", "/api/groups/" + group.id + "/invites/" + open.id, undefined, anna.cookie)).status, 404);
  assert.equal((await call("DELETE", "/api/groups/" + group.id + "/invites/" + open.id, undefined, luis.cookie)).status, 204);
  assert.deepEqual(await json(await call("GET", "/api/invites", undefined, anna.cookie)), []);
});

test("only the owner manages a group, members can leave, the owner cannot", async () => {
  const { luis, anna, tom } = await people();
  const group = await newGroup(luis);
  await join(group, luis, anna);
  const id = group.id;

  assert.equal((await call("PATCH", "/api/groups/" + id, { name: "Crew" }, anna.cookie)).status, 403);
  assert.equal((await call("DELETE", "/api/groups/" + id, undefined, anna.cookie)).status, 403);
  assert.equal((await call("POST", "/api/groups/" + id + "/invites", { username: "tom" }, anna.cookie)).status, 403);
  assert.equal((await call("PATCH", "/api/groups/" + id, { name: "Crew" }, luis.cookie)).status, 200);

  assert.equal((await call("DELETE", "/api/groups/" + id + "/members/" + luis.user.id, undefined, luis.cookie)).status, 400, "the owner stays");
  assert.equal((await call("DELETE", "/api/groups/" + id + "/members/" + anna.user.id, undefined, tom.cookie)).status, 404);
  assert.equal((await call("DELETE", "/api/groups/" + id + "/members/" + anna.user.id, undefined, anna.cookie)).status, 204, "leaving");
  assert.deepEqual(await json(await call("GET", "/api/groups", undefined, anna.cookie)), []);

  await join(group, luis, tom);
  assert.equal((await call("DELETE", "/api/groups/" + id + "/members/" + tom.user.id, undefined, luis.cookie)).status, 204, "the owner removes");

  assert.equal((await call("DELETE", "/api/groups/" + id, undefined, luis.cookie)).status, 204);
  assert.deepEqual(await json(await call("GET", "/api/groups", undefined, luis.cookie)), []);
});

test("leaving a group takes the other members' devices off the list", async () => {
  const { luis, anna } = await people();
  const group = await newGroup(luis);
  await join(group, luis, anna);

  const watcher = await s.connect({ cookie: anna.cookie });
  watcher.send({ type: "authenticate", viewer: true });
  assert.deepEqual(await watcher.next(), { successful: true });
  await watcher.next();
  const phone = await s.device("luis", "phone", luis.token);
  await phone.next();
  let update;
  do {
    update = await watcher.next();
  } while (update.type !== "dataResponse" || !update.devices.some((d) => d.owner.username === "luis"));

  await call("DELETE", "/api/groups/" + group.id + "/members/" + anna.user.id, undefined, anna.cookie);
  let seen;
  do {
    seen = await watcher.next();
  } while (seen.type !== "dataResponse");
  assert.ok(!seen.devices.some((d) => d.owner.username === "luis"), "luis is out of sight");
});

test("the admin sees everyone without being in a group, members only their groups", async () => {
  const { admin, anna, tom } = await people();
  // Every account is linked to a phone by the login in the helper.
  const list = async (user) => (await json(await call("GET", "/api/getData", undefined, user.cookie))).map((d) => d.owner.username).sort();
  assert.deepEqual(await list(admin), ["anna", "boss", "luis", "tom"]);
  assert.deepEqual(await list(anna), ["anna"]);
  assert.deepEqual(await list(tom), ["tom"]);
});

test("the Everyone group is created when groups are added to an existing database", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "neopin-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, " +
      "display_name TEXT NOT NULL, password_hash TEXT NOT NULL, avatar_b64 TEXT, avatar_type TEXT, avatar_version TEXT, " +
      "is_admin INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL); " +
      "INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES " +
      "('boss','Boss','x',1,'2025-01-01'),('anna','Anna','x',0,'2025-01-01');"
  );
  old.close();

  const db = initDb(file);
  const group = db.prepare("SELECT * FROM user_groups").get();
  assert.equal(group.name, "Everyone");
  assert.equal(group.owner_id, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM group_members").get().n, 2);
  assert.equal(initDb(file).prepare("SELECT COUNT(*) AS n FROM user_groups").get().n, 1, "opening it again adds nothing");
});

test("username suggestions match the start of the name and leave out members and yourself", async () => {
  const { luis, anna, tom } = await people();
  const search = async (user, q, extra = "") => json(await call("GET", "/api/users/search?q=" + encodeURIComponent(q) + extra, undefined, user.cookie));

  assert.deepEqual((await search(luis, "an")).map((u) => u.username), ["anna"]);
  assert.deepEqual((await search(luis, "ANNA")).map((u) => u.username), ["anna"], "case does not matter");
  assert.deepEqual((await search(luis, "o")).map((u) => u.username).sort(), ["boss", "tom"], "contains also matches, self left out");
  assert.deepEqual(await search(luis, "   "), []);
  assert.equal((await call("GET", "/api/users/search?q=a")).status, 401);

  const group = await newGroup(luis);
  await join(group, luis, anna);
  assert.deepEqual((await search(luis, "an", "&groupId=" + group.id)), [], "anna is already in the group");
  assert.deepEqual((await search(luis, "o", "&groupId=" + group.id)).map((u) => u.username).sort(), ["boss", "tom"]);
  await call("POST", "/api/groups/" + group.id + "/invites", { username: "tom" }, luis.cookie);
  assert.deepEqual((await search(luis, "o", "&groupId=" + group.id)).map((u) => u.username), ["boss"], "tom is already invited");
});

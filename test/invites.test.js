import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { resetFcm } from "../src/fcm.js";
import { deleteUser } from "../src/accounts.js";
import { setPushToken } from "../src/push.js";
import { normaliseCode } from "../src/invites.js";
import { PASSWORD, deviceHeaders, startServer } from "./helpers.js";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let s;
let fakeServer = null;
const saved = { ...config };

beforeEach(async () => {
  s = await startServer();
});

afterEach(async () => {
  config.invites = saved.invites;
  config.inviteMaxOpen = saved.inviteMaxOpen;
  config.inviteTtlDays = saved.inviteTtlDays;
  config.fcmServiceAccountJson = null;
  config.fcmUrl = null;
  config.fcmTokenUrl = null;
  resetFcm();
  await s.stop();
  if (fakeServer) {
    fakeServer.closeAllConnections();
    await new Promise((resolve) => fakeServer.close(resolve));
    fakeServer = null;
  }
});

// A stand-in for Google that records the messages.
async function startFake() {
  const sent = [];
  fakeServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/token") return res.end(JSON.stringify({ access_token: "access", expires_in: 3600 }));
      sent.push(JSON.parse(raw).message);
      res.end(JSON.stringify({ name: "ok" }));
    });
  });
  await new Promise((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${fakeServer.address().port}`;
  config.fcmServiceAccountJson = JSON.stringify({
    project_id: "neopin-test",
    client_email: "push@neopin-test.iam.gserviceaccount.com",
    private_key: privateKey,
    token_uri: `${base}/token`,
  });
  config.fcmUrl = `${base}/v1/projects/neopin-test/messages:send`;
  config.fcmTokenUrl = `${base}/token`;
  resetFcm();
  return sent;
}

const call = (method, route, body, who) =>
  fetch(s.baseUrl + route, {
    method,
    headers: { "content-type": "application/json", ...(who ? { cookie: who.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const make = async (who, body = {}) => {
  const res = await call("POST", "/api/invite-codes", body, who);
  assert.equal(res.status, 201);
  return res.json();
};

const register = (code, extra = {}) =>
  call("POST", "/api/register", { code, username: "newbie", password: PASSWORD, ...extra });

const rowOf = (id) => getDb().prepare("SELECT * FROM invite_codes WHERE id = ?").get(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("codes are created, listed and revoked", async () => {
  const admin = await s.account("boss");
  const luis = await s.account("luis");
  const anna = await s.account("anna");

  assert.equal((await call("POST", "/api/invite-codes", {})).status, 401);
  assert.equal((await call("GET", "/api/invite-codes")).status, 401);

  const code = await make(luis, { note: "  for Tom  " });
  assert.match(code.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(code.status, "open");
  assert.equal(code.note, "for Tom");
  assert.equal(code.groupId, null);
  assert.equal(code.groupName, null);
  assert.equal(code.createdBy.username, "luis");
  assert.deepEqual(Object.keys(code.createdBy).sort(), ["avatarUrl", "displayName", "id", "username"]);
  assert.equal(code.usedBy, null);
  assert.equal(code.usedAt, null);
  const days = (Date.parse(code.expiresAt) - Date.parse(code.createdAt)) / 86_400_000;
  assert.ok(Math.abs(days - config.inviteTtlDays) < 0.01);

  // The device token works as well as the cookie.
  const viaDevice = await fetch(s.baseUrl + "/api/invite-codes", {
    method: "POST",
    headers: { "content-type": "application/json", ...deviceHeaders("phone", anna.token) },
    body: JSON.stringify({}),
  });
  assert.equal(viaDevice.status, 201);

  const mine = await (await call("GET", "/api/invite-codes", undefined, luis)).json();
  assert.deepEqual(mine.map((c) => c.id), [code.id]);
  const all = await (await call("GET", "/api/invite-codes", undefined, admin)).json();
  assert.equal(all.length, 2);
  assert.ok(all[0].id > all[1].id, "newest first");

  assert.equal((await call("DELETE", `/api/invite-codes/${code.id}`, undefined, anna)).status, 404, "not hers");
  assert.equal((await call("DELETE", `/api/invite-codes/${code.id}`, undefined, luis)).status, 204);
  assert.equal((await call("DELETE", `/api/invite-codes/${code.id}`, undefined, luis)).status, 404, "not open anymore");
  assert.equal((await call("DELETE", "/api/invite-codes/999", undefined, luis)).status, 404);
  const [revoked] = await (await call("GET", "/api/invite-codes", undefined, luis)).json();
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.code, code.code, "the creator still sees the code");

  // The admin may revoke the codes of others.
  assert.equal((await call("DELETE", `/api/invite-codes/${all[0].id}`, undefined, admin)).status, 204);
  assert.equal((await register(revoked.code)).status, 404);
});

test("open codes are limited per account, the admin has no limit", async () => {
  const admin = await s.account("boss");
  const luis = await s.account("luis");
  config.inviteMaxOpen = 2;
  const first = await make(luis);
  await make(luis);
  const third = await call("POST", "/api/invite-codes", {}, luis);
  assert.equal(third.status, 429);
  assert.equal((await third.json()).type, "too-many-codes");

  // Revoking, using and expiring free a slot.
  await call("DELETE", `/api/invite-codes/${first.id}`, undefined, luis);
  const replacement = await make(luis);
  assert.equal((await call("POST", "/api/invite-codes", {}, luis)).status, 429);
  getDb().prepare("UPDATE invite_codes SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", replacement.id);
  await make(luis);

  for (let i = 0; i < 4; i++) await make(admin);
});

test("an expired code is shown as expired and cannot be used", async () => {
  await s.account("boss");
  const luis = await s.account("luis");
  const code = await make(luis);
  getDb().prepare("UPDATE invite_codes SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", code.id);
  const [listed] = await (await call("GET", "/api/invite-codes", undefined, luis)).json();
  assert.equal(listed.status, "expired");
  assert.equal((await call("DELETE", `/api/invite-codes/${code.id}`, undefined, luis)).status, 404);
  assert.equal((await register(code.code)).status, 404);
  assert.deepEqual(await (await call("POST", "/api/invite-codes/check", { code: code.code })).json(), { valid: false });
});

test("a code can be tied to a group the creator is in", async () => {
  const admin = await s.account("boss");
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const group = await (await call("POST", "/api/groups", { name: "Family" }, luis)).json();

  const code = await make(luis, { groupId: group.id });
  assert.equal(code.groupId, group.id);
  assert.equal(code.groupName, "Family");

  assert.equal((await call("POST", "/api/invite-codes", { groupId: group.id }, anna)).status, 404, "not a member");
  assert.equal((await call("POST", "/api/invite-codes", { groupId: 999 }, luis)).status, 404);
  assert.equal((await call("POST", "/api/invite-codes", { groupId: group.id }, admin)).status, 201, "the admin may use any");
  assert.equal((await call("POST", "/api/invite-codes", { note: "x".repeat(61) }, luis)).status, 400);
  assert.equal((await call("POST", "/api/invite-codes", { note: "x".repeat(60) }, luis)).status, 201);

  // A group that is deleted leaves the code in place without it.
  await call("DELETE", `/api/groups/${group.id}`, undefined, luis);
  const [listed] = (await (await call("GET", "/api/invite-codes", undefined, luis)).json()).filter((c) => c.id === code.id);
  assert.equal(listed.groupId, null);
  assert.equal(listed.groupName, null);
});

test("codes are normalised and the check never says why a code is invalid", async () => {
  await s.account("boss");
  const luis = await s.account("luis");
  getDb().prepare("UPDATE users SET display_name = 'Luis K' WHERE username = 'luis'").run();
  const code = await make(luis);

  assert.equal(normaliseCode(" ab-cd 0o1i l"), "ABCD00111");
  const check = async (input) => (await call("POST", "/api/invite-codes/check", { code: input })).json();

  assert.deepEqual(await check(code.code), { valid: true, invitedBy: "Luis K", groupName: null });
  assert.deepEqual(await check(code.code.toLowerCase().replace("-", " ")), { valid: true, invitedBy: "Luis K", groupName: null });
  assert.deepEqual(await check(code.code.replace("-", "")), { valid: true, invitedBy: "Luis K", groupName: null });
  assert.deepEqual(await check("AAAAA-AAAAA"), { valid: false });
  assert.deepEqual(await check(""), { valid: false });

  // Look-alikes in the stored code are typed the way the alphabet has them: 0 and 1.
  getDb().prepare("UPDATE invite_codes SET code = 'ABCDE01ABC' WHERE id = ?").run(code.id);
  assert.equal((await check("abcde-oLab c")).valid, true);

  const group = await (await call("POST", "/api/groups", { name: "Family" }, luis)).json();
  const grouped = await make(luis, { groupId: group.id });
  assert.equal((await check(grouped.code)).groupName, "Family");

  await call("DELETE", `/api/invite-codes/${grouped.id}`, undefined, luis);
  assert.deepEqual(await check(grouped.code), { valid: false });
});

test("registering creates the account, uses the code and joins the group", async () => {
  await s.account("boss");
  const luis = await s.account("luis");
  const group = await (await call("POST", "/api/groups", { name: "Family" }, luis)).json();
  const code = await make(luis, { groupId: group.id });

  const res = await register(code.code.toLowerCase(), { displayName: "  New Person  " });
  assert.equal(res.status, 201);
  const user = await res.json();
  assert.equal(user.username, "newbie");
  assert.equal(user.displayName, "New Person");
  assert.equal(user.isAdmin, false);
  assert.equal(user.mustChangePassword, false);
  assert.deepEqual(Object.keys(user).sort(), ["avatarUrl", "displayName", "id", "isAdmin", "mustChangePassword", "primaryDeviceId", "username"]);

  // The member list has the new account, no pending invite.
  const [view] = await (await call("GET", "/api/groups", undefined, luis)).json();
  assert.deepEqual(view.members.map((m) => m.username), ["luis", "newbie"]);
  assert.deepEqual(view.pendingInvites, []);
  const cookie = await s.cookieFor("newbie");
  const mine = await (await fetch(s.baseUrl + "/api/groups", { headers: { cookie } })).json();
  assert.ok(mine.some((g) => g.id === group.id));

  const [listed] = await (await call("GET", "/api/invite-codes", undefined, luis)).json();
  assert.equal(listed.status, "used");
  assert.equal(listed.usedBy.username, "newbie");
  assert.ok(listed.usedAt);
  assert.equal(listed.code, code.code);

  // Single use.
  assert.equal((await register(code.code, { username: "second" })).status, 404);
  const login = await s.post("/api/auth/login", { username: "newbie", password: PASSWORD, deviceId: "d" });
  assert.equal(login.status, 200);
});

test("a code without a group lands in no group, a code with one adds just that one", async () => {
  await s.account("boss");
  const luis = await s.account("luis");
  const other = await (await call("POST", "/api/groups", { name: "Everyone" }, luis)).json();
  const groupsOf = (username) =>
    getDb()
      .prepare("SELECT m.group_id AS id FROM group_members m JOIN users u ON u.id = m.user_id WHERE u.username = ? ORDER BY m.group_id")
      .all(username)
      .map((r) => r.id);

  assert.equal((await register((await make(luis)).code)).status, 201);
  assert.deepEqual(groupsOf("newbie"), []);

  const family = await (await call("POST", "/api/groups", { name: "Family" }, luis)).json();
  const code = await make(luis, { groupId: family.id });
  assert.equal((await register(code.code, { username: "second" })).status, 201);
  assert.deepEqual(groupsOf("second"), [family.id], `not ${other.name}`);
});

test("every invalid code gets the same answer", async () => {
  const admin = await s.account("boss");
  const luis = await s.account("luis");
  const used = await make(luis);
  assert.equal((await register(used.code, { username: "first" })).status, 201);
  const expired = await make(luis);
  getDb().prepare("UPDATE invite_codes SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", expired.id);
  const revoked = await make(luis);
  await call("DELETE", `/api/invite-codes/${revoked.id}`, undefined, luis);
  await make(admin);

  const bodies = [];
  for (const code of [used.code, expired.code, revoked.code, "ZZZZZ-ZZZZZ", "short", ""]) {
    const res = await register(code);
    assert.equal(res.status, 404, code);
    const { requestId, ...body } = await res.json();
    bodies.push(body);
  }
  for (const body of bodies) assert.deepEqual(body, bodies[0]);
  assert.match(JSON.stringify(bodies[0]), /invalid-code/);
  assert.match(JSON.stringify(bodies[0]), /This invite code is not valid/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'newbie'").get().n, 0);
});

test("a bad or taken username leaves the code unused", async () => {
  await s.account("boss");
  const luis = await s.account("luis");
  const code = await make(luis);

  const taken = await register(code.code, { username: "LUIS" });
  assert.equal(taken.status, 409);
  const short = await register(code.code, { username: "x" });
  assert.equal(short.status, 400);
  assert.match((await short.json()).detail ?? JSON.stringify(await short.clone().json()), /Username/);
  const weak = await register(code.code, { password: "short" });
  assert.equal(weak.status, 400);
  assert.match(JSON.stringify(await weak.json()), /at least 8 characters/);

  assert.equal(rowOf(code.id).used_at, null);
  assert.equal(rowOf(code.id).used_by, null);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM users").get().n, 2);
  assert.equal((await register(code.code)).status, 201, "still good");
});

test("guessing codes is rate limited per IP, like wrong device tokens", async () => {
  await s.account("boss");
  const luis = await s.account("luis");
  const code = await make(luis);
  const max = config.deviceAuthLimit.max;
  s.server.resetAuthFailures();

  for (let i = 0; i < max; i++) {
    const res = i % 2 ? await register("AAAAA-AAAAA") : await call("POST", "/api/invite-codes/check", { code: "AAAAA-AAAAA" });
    assert.equal(res.status, i % 2 ? 404 : 200);
  }
  assert.equal((await register(code.code)).status, 429);
  assert.equal((await call("POST", "/api/invite-codes/check", { code: code.code })).status, 429);
  // Wrong device tokens share the counter.
  const device = await fetch(s.baseUrl + "/api/me", { headers: deviceHeaders("phone", luis.token) });
  assert.equal(device.status, 429);

  s.server.resetAuthFailures();
  assert.equal((await register(code.code)).status, 201);
});

test("using a code notifies the admin and the creator, over the socket and push", async () => {
  const sent = await startFake();
  const admin = await s.account("boss");
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  getDb().prepare("UPDATE users SET display_name = 'Luis K' WHERE username = 'luis'").run();
  setPushToken(admin.user.id, "phone", "admin-fcm", "android");
  setPushToken(luis.user.id, "phone", "luis-fcm", "android");
  setPushToken(anna.user.id, "phone", "anna-fcm", "android");

  const adminDevice = await s.device("boss", "phone");
  const luisDashboard = await s.connect({ cookie: luis.cookie });
  luisDashboard.send({ type: "authenticate", viewer: true });
  await s.device("anna", "phone");

  const group = await (await call("POST", "/api/groups", { name: "Family" }, luis)).json();
  const code = await make(luis, { groupId: group.id });
  assert.equal((await register(code.code, { displayName: "Tom" })).status, 201);

  const changed = async (client) => {
    for (let i = 0; i < 20; i++) {
      const msg = await client.next();
      if (msg.type === "notificationsChanged") return true;
    }
    return false;
  };
  assert.equal(await changed(adminDevice), true);
  assert.equal(await changed(luisDashboard), true);

  const expected = {
    type: "inviteUsed",
    readAt: null,
    data: {
      user: { username: "newbie", displayName: "Tom", avatarUrl: null },
      invitedBy: { username: "luis", displayName: "Luis K" },
      groupName: "Family",
    },
  };
  for (const who of [admin, luis]) {
    const list = await (await call("GET", "/api/notifications", undefined, who)).json();
    assert.equal(list.length, 1, "once each");
    assert.equal(list[0].type, expected.type);
    assert.equal(list[0].readAt, null);
    assert.equal(list[0].data.user.username, "newbie");
    assert.equal(list[0].data.user.displayName, "Tom");
    assert.equal(list[0].data.user.avatarUrl, null);
    assert.equal(typeof list[0].data.user.id, "number");
    assert.equal(list[0].data.invitedBy.username, "luis");
    assert.equal(list[0].data.invitedBy.displayName, "Luis K");
    assert.equal(list[0].data.groupName, "Family");
    assert.ok(list[0].createdAt);
  }
  assert.deepEqual(await (await call("GET", "/api/notifications", undefined, anna)).json(), [], "others hear nothing");

  await wait(100);
  assert.deepEqual(sent.map((m) => m.token).sort(), ["admin-fcm", "luis-fcm"]);
  for (const message of sent) {
    assert.deepEqual(message.notification, { title: "New account", body: "Tom joined with Luis K's invite code" });
    assert.deepEqual(message.data, { type: "inviteUsed" });
    assert.equal(message.android.notification.channel_id, "default");
  }
});

test("the admin is told once when the admin made the code", async () => {
  const sent = await startFake();
  const admin = await s.account("boss");
  setPushToken(admin.user.id, "phone", "admin-fcm", "android");
  const code = await make(admin);
  assert.equal((await register(code.code)).status, 201);
  const list = await (await call("GET", "/api/notifications", undefined, admin)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].data.groupName, null);
  await wait(100);
  assert.equal(sent.length, 1);
});

test("notifications are marked read, own ones only, newest first", async () => {
  const admin = await s.account("boss");
  const luis = await s.account("luis");
  for (const name of ["amy", "ann", "ava"]) {
    const code = await make(luis);
    assert.equal((await register(code.code, { username: name })).status, 201);
  }
  const list = await (await call("GET", "/api/notifications", undefined, admin)).json();
  assert.deepEqual(list.map((n) => n.data.user.username), ["ava", "ann", "amy"]);

  assert.equal((await call("POST", "/api/notifications/read", { ids: [list[0].id] }, admin)).status, 204);
  // Somebody else's id changes nothing.
  assert.equal((await call("POST", "/api/notifications/read", { ids: list.map((n) => n.id) }, luis)).status, 204);
  let after = await (await call("GET", "/api/notifications", undefined, admin)).json();
  assert.deepEqual(after.map((n) => n.readAt !== null), [true, false, false]);
  const luisList = await (await call("GET", "/api/notifications", undefined, luis)).json();
  assert.ok(luisList.every((n) => n.readAt === null), "luis's own stay unread");

  assert.equal((await call("POST", "/api/notifications/read", undefined, admin)).status, 204);
  after = await (await call("GET", "/api/notifications", undefined, admin)).json();
  assert.ok(after.every((n) => n.readAt !== null));
  assert.equal((await call("POST", "/api/notifications/read", {})).status, 401);
  assert.equal((await call("GET", "/api/notifications")).status, 401);

  for (let i = 0; i < 52; i++) {
    getDb()
      .prepare("INSERT INTO notifications (user_id, type, data, created_at) VALUES (?, 'inviteUsed', ?, ?)")
      .run(admin.user.id, JSON.stringify({ user: { id: 1, username: "x", displayName: "x", avatarUrl: null }, invitedBy: { id: 1, username: "x", displayName: "x" }, groupName: null }), new Date().toISOString());
  }
  assert.equal((await (await call("GET", "/api/notifications", undefined, admin)).json()).length, 50);
});

test("INVITE_CODES=off turns the feature off", async () => {
  await s.account("boss");
  const luis = await s.account("luis");
  const code = await make(luis);
  config.invites = false;

  for (const res of [
    await call("POST", "/api/invite-codes", {}, luis),
    await call("POST", "/api/invite-codes/check", { code: code.code }),
    await register(code.code),
  ]) {
    assert.equal(res.status, 404);
    assert.match(JSON.stringify(await res.json()), /invites-off/);
  }
  assert.equal((await (await fetch(s.baseUrl + "/api/status")).json()).invites, false);
  config.invites = true;
  assert.equal((await (await fetch(s.baseUrl + "/api/status")).json()).invites, true);
});

test("removing the creator removes the codes, removing the user keeps the code as used", async () => {
  const admin = await s.account("boss");
  const luis = await s.account("luis");
  const code = await make(luis);
  const gone = await make(luis);
  const res = await register(code.code);
  assert.equal(res.status, 201);
  const newbie = await res.json();

  deleteUser(newbie.id);
  const [listed] = (await (await call("GET", "/api/invite-codes", undefined, admin)).json()).filter((c) => c.id === code.id);
  assert.equal(listed.status, "used");
  assert.equal(listed.usedBy, null);

  deleteUser(luis.user.id);
  assert.equal(rowOf(code.id), undefined);
  assert.equal(rowOf(gone.id), undefined);
});

test("an invite link is a page anyone can open, signed in or not", async () => {
  const res = await fetch(s.baseUrl + "/invite/ABCDE-12345");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /\/assets\/scripts\/invite\.js/);
  assert.equal((await fetch(s.baseUrl + "/assets/scripts/invite.js")).status, 200);
});

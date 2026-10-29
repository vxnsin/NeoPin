import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HIDDEN_FOREVER } from "../src/accounts.js";
import { getDb } from "../src/db.js";
import { shareGroup, startServer } from "./helpers.js";

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

// One group with all of them, so everybody sees everybody until someone hides.
const everyone = (...accounts) => shareGroup("Everyone", ...accounts.map((a) => a.user));

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

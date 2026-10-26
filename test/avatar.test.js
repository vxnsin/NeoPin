import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { deviceHeaders, startServer } from "./helpers.js";

let s;
let luis;

beforeEach(async () => {
  s = await startServer();
  luis = await s.account("luis");
});

afterEach(() => s.stop());

// A JPEG as far as the server looks: the start-of-image marker and some bytes.
const jpeg = (fill = 1, size = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill)]);

const upload = (body, { token = luis.token, deviceId = "phone", type = "image/jpeg", headers } = {}) =>
  fetch(`${s.baseUrl}/api/avatar`, {
    method: "PUT",
    headers: { ...(headers ?? deviceHeaders(deviceId, token)), "content-type": type },
    body,
  });

test("an account uploads its picture and every device gets the new avatarUrl", async () => {
  const phone = await s.device("luis", "phone", luis.token);
  await phone.next();

  const res = await upload(jpeg());
  assert.equal(res.status, 200);
  const { avatarUrl } = await res.json();
  assert.match(avatarUrl, new RegExp(`^/avatars/${luis.user.id}\\?v=[\\w-]{12}$`));

  const update = await phone.next();
  assert.equal(update.type, "dataResponse");
  assert.equal(update.devices[0].avatarUrl, avatarUrl);
});

test("the picture is stored as a base64 string in the database", async () => {
  const picture = jpeg(5);
  await upload(picture);
  const row = getDb().prepare("SELECT avatar_b64, avatar_type FROM users WHERE id = ?").get(luis.user.id);
  assert.equal(row.avatar_type, "image/jpeg");
  assert.deepEqual(Buffer.from(row.avatar_b64, "base64"), picture);
});

test("the picture is served to everyone who is signed in", async () => {
  const picture = jpeg(7);
  const { avatarUrl } = await (await upload(picture)).json();

  const forDashboard = await fetch(s.baseUrl + avatarUrl, { headers: { cookie: luis.cookie } });
  assert.equal(forDashboard.status, 200);
  assert.equal(forDashboard.headers.get("content-type"), "image/jpeg");
  assert.match(forDashboard.headers.get("cache-control"), /immutable/);
  assert.deepEqual(Buffer.from(await forDashboard.arrayBuffer()), picture);

  assert.equal((await fetch(s.baseUrl + avatarUrl, { headers: deviceHeaders("phone", luis.token) })).status, 200);
  assert.equal((await fetch(s.baseUrl + avatarUrl)).status, 401);

  const anna = await s.account("anna");
  assert.equal((await fetch(s.baseUrl + avatarUrl, { headers: { cookie: anna.cookie } })).status, 200, "the others see it too");
  assert.equal((await fetch(`${s.baseUrl}/avatars/${anna.user.id}`, { headers: { cookie: luis.cookie } })).status, 404, "anna has none");
});

test("an upload needs a valid login", async () => {
  assert.equal((await upload(jpeg(), { token: "wrong" })).status, 401);
  assert.equal((await upload(jpeg(), { headers: {} })).status, 401);
  assert.equal((await upload(jpeg(), { deviceId: "tablet" })).status, 401, "the token belongs to another device");
});

test("the dashboard can set the picture too", async () => {
  const res = await upload(jpeg(), { headers: { cookie: luis.cookie } });
  assert.equal(res.status, 200);
});

test("wrong tokens on the upload count against the same limit as socket logins", async () => {
  for (let i = 0; i < config.deviceAuthLimit.max; i++) {
    assert.equal((await upload(jpeg(), { token: "wrong" })).status, 401);
  }
  assert.equal((await upload(jpeg())).status, 429);
});

test("device names outside ASCII work once percent-encoded", async () => {
  const token = await s.tokenFor("luis", "Luis’ iPhone");
  assert.equal((await upload(jpeg(), { token, deviceId: "Luis’ iPhone" })).status, 200);
});

test("only small pictures of a known type are taken", async () => {
  assert.equal((await upload("hello", { type: "text/plain" })).status, 415);
  assert.equal((await upload(jpeg(1, 17 * 1024))).status, 413);
  assert.equal((await upload(Buffer.from("<svg onload=alert(1)>"), { type: "image/jpeg" })).status, 400);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  assert.equal((await upload(png, { type: "image/png" })).status, 200);
  assert.equal((await upload(png, { type: "image/jpeg" })).status, 400, "type and bytes must agree");
});

test("a new picture gets a new URL and deleting it clears avatarUrl", async () => {
  await s.device("luis", "phone", luis.token);
  const first = (await (await upload(jpeg(1))).json()).avatarUrl;
  const second = (await (await upload(jpeg(2))).json()).avatarUrl;
  assert.notEqual(first, second);

  const removed = await fetch(`${s.baseUrl}/api/avatar`, { method: "DELETE", headers: deviceHeaders("phone", luis.token) });
  assert.equal(removed.status, 204);

  const me = await (await fetch(`${s.baseUrl}/api/me`, { headers: { cookie: luis.cookie } })).json();
  assert.equal(me.avatarUrl, null);
  assert.equal((await fetch(s.baseUrl + second, { headers: { cookie: luis.cookie } })).status, 404);
});

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { config } from "../src/config.js";
import { resetFcm } from "../src/fcm.js";
import { pushTokenOf } from "../src/push.js";
import { deviceHeaders, shareGroup, startServer } from "./helpers.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let s;
let fake;
let fakeServer;

// A stand-in for Google: the OAuth token endpoint and messages:send.
async function startFake() {
  const state = { tokenCalls: 0, jwtValid: [], sent: [], onSend: null, answer: () => ({ status: 200, body: { name: "ok" } }) };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const reply = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/token") {
        state.tokenCalls++;
        const params = new URLSearchParams(raw);
        const [head, claims, signature] = (params.get("assertion") ?? "").split(".");
        const valid =
          params.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" &&
          crypto.verify("RSA-SHA256", Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(signature ?? "", "base64url")) &&
          JSON.parse(Buffer.from(claims, "base64url")).iss === "push@neopin-test.iam.gserviceaccount.com";
        state.jwtValid.push(valid);
        return reply(200, { access_token: `access-${state.tokenCalls}`, expires_in: 3600 });
      }
      if (req.url === "/v1/projects/neopin-test/messages:send") {
        const { message } = JSON.parse(raw);
        state.sent.push({ message, authorization: req.headers.authorization });
        state.onSend?.(message);
        const { status, body } = state.answer(message);
        return reply(status, body);
      }
      reply(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.fcmServiceAccountJson = JSON.stringify({
    project_id: "neopin-test",
    client_email: "push@neopin-test.iam.gserviceaccount.com",
    private_key: privateKey,
    token_uri: `${base}/token`,
  });
  config.fcmUrl = `${base}/v1/projects/neopin-test/messages:send`;
  config.fcmTokenUrl = `${base}/token`;
  resetFcm();
  fakeServer = server;
  return state;
}

beforeEach(async () => {
  config.pushWaitMs = 500;
  s = await startServer();
  fake = await startFake();
});

afterEach(async () => {
  config.fcmServiceAccountJson = null;
  config.fcmServiceAccountFile = null;
  config.fcmUrl = null;
  config.fcmTokenUrl = null;
  resetFcm();
  await s.stop();
  fakeServer.closeAllConnections();
  await new Promise((resolve) => fakeServer.close(resolve));
});

const putToken = (who, deviceId, body = { token: "fcm-token", platform: "android" }) =>
  fetch(`${s.baseUrl}/api/push-token`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...deviceHeaders(deviceId, who.token) },
    body: JSON.stringify(body),
  });

const ping = (who, body) => s.post("/api/sendPing", body, { cookie: who.cookie });

// The app's background task: a short socket that reports one position.
async function reportFrom(username, deviceId) {
  const client = await s.device(username, deviceId);
  client.send({ type: "updatePosition", latitude: 5, longitude: 6 });
  return client;
}

test("status says whether push is configured", async () => {
  assert.equal((await (await fetch(`${s.baseUrl}/api/status`)).json()).push, true);
  config.fcmServiceAccountJson = null;
  resetFcm();
  assert.equal((await (await fetch(`${s.baseUrl}/api/status`)).json()).push, false);
  config.fcmServiceAccountJson = "{ not json";
  resetFcm();
  assert.equal((await (await fetch(`${s.baseUrl}/api/status`)).json()).push, false);
});

test("push token routes need the device token and validate the body", async () => {
  const luis = await s.account("luis");
  const anon = await fetch(`${s.baseUrl}/api/push-token`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "x", platform: "android" }),
  });
  assert.equal(anon.status, 401);
  // A dashboard cookie is no device.
  const cookieOnly = await fetch(`${s.baseUrl}/api/push-token`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: luis.cookie },
    body: JSON.stringify({ token: "x", platform: "android" }),
  });
  assert.equal(cookieOnly.status, 401);
  assert.equal((await putToken({ token: "wrong" }, "phone")).status, 401);

  assert.equal((await putToken(luis, "phone", { token: "x", platform: "windows" })).status, 400);
  assert.equal((await putToken(luis, "phone", { token: "x".repeat(4097), platform: "android" })).status, 400);
  assert.equal((await putToken(luis, "phone", { token: "", platform: "android" })).status, 400);

  assert.equal((await putToken(luis, "phone")).status, 204);
  assert.equal(pushTokenOf(luis.user.id, "phone").token, "fcm-token");
  assert.equal((await putToken(luis, "phone", { token: "fresh", platform: "ios" })).status, 204);
  assert.deepEqual(
    { token: pushTokenOf(luis.user.id, "phone").token, platform: pushTokenOf(luis.user.id, "phone").platform },
    { token: "fresh", platform: "ios" }
  );

  const gone = await fetch(`${s.baseUrl}/api/push-token`, { method: "DELETE", headers: deviceHeaders("phone", luis.token) });
  assert.equal(gone.status, 204);
  assert.equal(pushTokenOf(luis.user.id, "phone"), null);
  assert.equal((await fetch(`${s.baseUrl}/api/push-token`, { method: "DELETE" })).status, 401);
});

test("the push token goes with the device: logout, unlink, account removal", async () => {
  const admin = await s.account("boss");
  const luis = await s.account("luis");
  await putToken(luis, "phone");
  const out = await fetch(`${s.baseUrl}/api/auth/logout`, { method: "POST", headers: deviceHeaders("phone", luis.token) });
  assert.equal(out.status, 200);
  assert.equal(pushTokenOf(luis.user.id, "phone"), null);

  const tablet = await s.tokenFor("luis", "tablet");
  await putToken({ token: tablet }, "tablet");
  const unlink = await fetch(`${s.baseUrl}/api/devices/tablet`, { method: "DELETE", headers: { cookie: luis.cookie } });
  assert.equal(unlink.status, 204);
  assert.equal(pushTokenOf(luis.user.id, "tablet"), null);

  const anna = await s.account("anna");
  await putToken(anna, "phone");
  const removed = await fetch(`${s.baseUrl}/api/users/${anna.user.id}`, { method: "DELETE", headers: { cookie: admin.cookie } });
  assert.equal(removed.status, 204);
  assert.equal(pushTokenOf(anna.user.id, "phone"), null);
});

test("a wake-up is a data-only high-priority message, the access token is cached", async () => {
  const luis = await s.account("luis");
  await putToken(luis, "phone", { token: "tok-1", platform: "android" });
  await ping(luis, { deviceId: "phone" });

  assert.equal(fake.sent.length, 1);
  const { message, authorization } = fake.sent[0];
  assert.equal(authorization, "Bearer access-1");
  assert.deepEqual(Object.keys(message).sort(), ["android", "data", "token"]);
  assert.equal(message.token, "tok-1");
  assert.deepEqual(message.android, { priority: "HIGH", ttl: "60s" });
  assert.deepEqual(Object.keys(message.data).sort(), ["from", "id", "type"]);
  assert.equal(message.data.type, "requestLocation");
  assert.equal(message.data.from, "luis");
  assert.match(message.data.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fake.jwtValid, [true]);

  // A second device wakes with the same access token.
  const second = await s.tokenFor("luis", "watch");
  await putToken({ token: second }, "watch", { token: "tok-2", platform: "android" });
  await ping(luis, { deviceId: "watch" });
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.tokenCalls, 1);
  assert.equal(fake.sent[1].authorization, "Bearer access-1");
});

test("at most one wake-up per device every ten seconds", async () => {
  const luis = await s.account("luis");
  await putToken(luis, "phone");
  assert.equal((await ping(luis, { deviceId: "phone" })).status, 202);
  assert.equal((await ping(luis, { deviceId: "phone" })).status, 202);
  assert.equal(fake.sent.length, 1);
});

test("a token FCM calls unregistered is deleted", async () => {
  const luis = await s.account("luis");
  await putToken(luis, "phone", { token: "dead", platform: "android" });
  fake.answer = () => ({
    status: 404,
    body: { error: { code: 404, status: "NOT_FOUND", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } },
  });
  const res = await ping(luis, { deviceId: "phone" });
  assert.equal(res.status, 502);
  assert.equal(pushTokenOf(luis.user.id, "phone"), null);

  await putToken(luis, "phone", { token: "bad", platform: "android" });
  fake.answer = () => ({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "bad token" } } });
  // Past the cooldown of the failed attempt: a failed send does not count.
  assert.equal((await ping(luis, { deviceId: "phone" })).status, 502);
  assert.equal(pushTokenOf(luis.user.id, "phone"), null);

  // Other errors keep the token.
  await putToken(luis, "phone", { token: "keep", platform: "android" });
  fake.answer = () => ({ status: 500, body: { error: { status: "INTERNAL" } } });
  assert.equal((await ping(luis, { deviceId: "phone" })).status, 502);
  assert.equal(pushTokenOf(luis.user.id, "phone").token, "keep");
});

test("an offline device that answers the wake-up gives the refreshed list", async () => {
  const luis = await s.account("luis");
  await s.account("anna");
  await putToken(luis, "phone");
  fake.onSend = () => reportFrom("luis", "phone");
  const res = await ping(luis, { deviceId: "phone" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.message, "Location request sent to phone");
  assert.deepEqual(body.devices.find((d) => d.deviceId === "phone").position, { latitude: 5, longitude: 6 });
});

test("an offline device that stays silent gets a 202", async () => {
  const luis = await s.account("luis");
  await putToken(luis, "phone");
  const res = await ping(luis, { deviceId: "phone" });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { message: "Location requested, the device has not answered yet" });
  assert.equal(fake.sent.length, 1);
});

test("without a push token, or with push off, an offline device stays a 404", async () => {
  const luis = await s.account("luis");
  await s.device("luis", "tablet");
  assert.equal((await ping(luis, { deviceId: "phone" })).status, 404);
  assert.equal(fake.sent.length, 0);

  await putToken(luis, "phone");
  config.fcmServiceAccountJson = null;
  resetFcm();
  assert.equal((await ping(luis, { deviceId: "phone" })).status, 404);
  assert.equal(fake.sent.length, 0);
});

test("only devices of people in a shared group are woken", async () => {
  await s.account("boss");
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  await s.device("luis", "tablet");
  await putToken(anna, "phone");

  assert.equal((await ping(luis, { deviceId: "phone", userId: anna.user.id })).status, 404);
  assert.equal(fake.sent.length, 0);

  shareGroup("Family", luis.user, anna.user);
  fake.onSend = () => reportFrom("anna", "phone");
  const res = await ping(luis, { deviceId: "phone", userId: anna.user.id });
  assert.equal(res.status, 200);
  assert.equal(fake.sent.at(-1).message.data.from, "luis");
});

test("a hidden account is not woken for others", async () => {
  await s.account("boss");
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  shareGroup("Family", luis.user, anna.user);
  await s.device("luis", "tablet");
  await putToken(anna, "phone");
  await fetch(`${s.baseUrl}/api/me/hidden`, { method: "PUT", headers: { "content-type": "application/json", cookie: anna.cookie }, body: "{}" });
  assert.equal((await ping(luis, { deviceId: "phone", userId: anna.user.id })).status, 404);
  assert.equal(fake.sent.length, 0);
});

test("an online device is asked over its socket, no push", async () => {
  const luis = await s.account("luis");
  await putToken(luis, "phone");
  const phone = await s.device("luis", "phone");
  const asked = ping(luis, { deviceId: "phone" });
  let request = await phone.next();
  while (request.type !== "requestLocation") request = await phone.next();
  phone.send({ type: "updatePosition", latitude: 3, longitude: 4 });
  assert.equal((await asked).status, 200);
  assert.equal(fake.sent.length, 0);
});

test("an invite pushes a notification to the devices of the invited person", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  await putToken(anna, "phone", { token: "anna-token", platform: "android" });
  const group = await (
    await s.post("/api/groups", { name: "Family" }, { cookie: luis.cookie })
  ).json();
  const res = await s.post(`/api/groups/${group.id}/invites`, { username: "anna" }, { cookie: luis.cookie });
  assert.equal(res.status, 201);
  for (let i = 0; i < 50 && fake.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));

  assert.equal(fake.sent.length, 1);
  const { message } = fake.sent[0];
  assert.equal(message.token, "anna-token");
  assert.deepEqual(message.notification, { title: "Group invitation", body: "luis invited you to Family" });
  assert.deepEqual(message.data, { type: "groupInvite", groupId: String(group.id) });
  assert.deepEqual(message.android, { priority: "HIGH", notification: { channel_id: "default" } });
});

test("with push off nothing is sent and invites still work", async () => {
  config.fcmServiceAccountJson = null;
  resetFcm();
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  await putToken(anna, "phone");
  const group = await (await s.post("/api/groups", { name: "Family" }, { cookie: luis.cookie })).json();
  assert.equal((await s.post(`/api/groups/${group.id}/invites`, { username: "anna" }, { cookie: luis.cookie })).status, 201);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.tokenCalls, 0);
});

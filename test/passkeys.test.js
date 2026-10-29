import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { deviceHeaders, startServer } from "./helpers.js";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { CHALLENGE_TTL_MS, relyingParty, resetPasskeyChallenges } from "../src/passkeys.js";

const HOST = "neopin.test";
const ORIGIN = `https://${HOST}`;
let s;

test.beforeEach(async () => {
  config.publicUrl = ORIGIN;
  resetPasskeyChallenges();
  s = await startServer();
});

test.afterEach(async () => {
  config.publicUrl = null;
  await s.stop();
});

// fetch always sends the real Host, passkeys care about it. Answers { status, headers, body }.
function call(method, route, { body, cookie, host = HOST, headers = {} } = {}) {
  const url = new URL(s.baseUrl + route);
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          host,
          ...(cookie ? { cookie } : {}),
          ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          const json = String(res.headers["content-type"]).includes("json");
          resolve({ status: res.statusCode, headers: res.headers, body: json && text ? JSON.parse(text) : text || null });
        });
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();
const uint32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

// A software authenticator: an ES256 key, "none" attestation, a signature counter.
function authenticator({ rpId = HOST, origin = ORIGIN } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const rawId = crypto.randomBytes(16);
  const id = b64u(rawId);
  const rpIdHash = sha256(rpId);
  let counter = 0;
  let handle = null;
  return {
    id,
    create(options) {
      handle = options.user.id;
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
      const cose = isoCBOR.encode(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x, "base64url")],
          [-3, Buffer.from(jwk.y, "base64url")],
        ])
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(rawId.length);
      // Flags: user present, user verified, attested credential data.
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), uint32(counter), Buffer.alloc(16), length, rawId, Buffer.from(cose)]);
      const attestation = isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return {
        id,
        rawId: id,
        type: "public-key",
        response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestation), transports: ["internal"] },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    get(options, { count, userHandle = handle } = {}) {
      counter = count ?? counter + 1;
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), uint32(counter)]);
      const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(clientData)]), privateKey);
      return {
        id,
        rawId: id,
        type: "public-key",
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle },
        clientExtensionResults: {},
      };
    },
  };
}

async function addPasskey(cookie, key, name = "iPhone") {
  const options = await call("POST", "/api/passkeys/register/options", { cookie });
  assert.equal(options.status, 200);
  return call("POST", "/api/passkeys/register", { cookie, body: { name, credential: key.create(options.body) } });
}

async function passkeyLogin(key, extra) {
  const options = await call("POST", "/login/passkey/options");
  assert.equal(options.status, 200);
  return call("POST", "/login/passkey", { body: { credential: key.get(options.body, extra) } });
}

test("passkeys are bound to PUBLIC_URL or the Host, and need HTTPS or localhost", () => {
  config.publicUrl = null;
  assert.deepEqual(relyingParty({ host: "neopin.example.com", secure: true }), { id: "neopin.example.com", origin: "https://neopin.example.com" });
  assert.deepEqual(relyingParty({ host: "localhost:3012", secure: false }), { id: "localhost", origin: "http://localhost:3012" });
  assert.deepEqual(relyingParty({ host: "pi.localhost:3012", secure: false }), { id: "pi.localhost", origin: "http://pi.localhost:3012" });
  assert.equal(relyingParty({ host: "neopin.example.com", secure: false }), null);
  assert.equal(relyingParty({ host: "192.168.1.20:3012", secure: false }), null);
  assert.equal(relyingParty({ host: "192.168.1.20", secure: true }), null);
  assert.equal(relyingParty({ host: "[::1]:3012", secure: true }), null);
  assert.equal(relyingParty({ host: undefined, secure: true }), null);

  config.publicUrl = "https://neopin.example.com/";
  assert.deepEqual(relyingParty({ host: "neopin.example.com", secure: false }), { id: "neopin.example.com", origin: "https://neopin.example.com" });
  assert.equal(relyingParty({ host: "192.168.1.20:3012", secure: false }), null, "opened by another address");
  config.publicUrl = "http://neopin.example.com";
  assert.equal(relyingParty({ host: "neopin.example.com", secure: false }), null);
});

test("the status says whether this address can use passkeys", async () => {
  assert.equal((await call("GET", "/api/status")).body.passkeys, true);
  assert.equal((await call("GET", "/api/status", { host: "192.168.1.20:3012" })).body.passkeys, false);
  const off = await call("POST", "/login/passkey/options", { host: "192.168.1.20:3012" });
  assert.equal(off.status, 404);
});

test("registration options fit the account and need the dashboard session", async () => {
  const { cookie, token } = await s.account("luis");
  const options = await call("POST", "/api/passkeys/register/options", { cookie });
  assert.equal(options.status, 200);
  assert.equal(options.body.rp.id, HOST);
  assert.equal(options.body.user.name, "luis");
  assert.equal(options.body.authenticatorSelection.residentKey, "required");
  assert.equal(options.body.attestation, "none");
  assert.deepEqual(options.body.excludeCredentials, []);
  assert.ok(options.body.challenge.length >= 32);

  assert.equal((await call("POST", "/api/passkeys/register/options")).status, 401);
  // The app's token is not enough to add a login that outlives a password change.
  assert.equal((await call("POST", "/api/passkeys/register/options", { headers: deviceHeaders("phone", token) })).status, 401);
});

test("a passkey is stored with its name, listed, and excluded from the next registration", async () => {
  const { cookie } = await s.account("luis");
  const key = authenticator();
  const added = await addPasskey(cookie, key, "  iPhone  ");
  assert.equal(added.status, 201);
  assert.equal(added.body.name, "iPhone");
  assert.equal(added.body.lastUsedAt, null);

  const row = getDb().prepare("SELECT * FROM passkeys").get();
  assert.equal(row.credential_id, key.id);
  assert.equal(row.counter, 0);
  assert.deepEqual(JSON.parse(row.transports), ["internal"]);
  assert.ok(row.public_key.length > 60);

  const list = await call("GET", "/api/passkeys", { cookie });
  assert.deepEqual(list.body, [added.body]);
  const next = await call("POST", "/api/passkeys/register/options", { cookie });
  assert.deepEqual(next.body.excludeCredentials.map((c) => c.id), [key.id]);

  // The same authenticator again is refused.
  const again = await call("POST", "/api/passkeys/register", { cookie, body: { name: "Twice", credential: key.create(next.body) } });
  assert.equal(again.status, 400);
});

test("a registration only counts with a fresh challenge of this account and this origin", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const options = await call("POST", "/api/passkeys/register/options", { cookie: luis.cookie });

  // Another account cannot use luis' challenge, and the try uses it up.
  const stolen = await call("POST", "/api/passkeys/register", { cookie: anna.cookie, body: { name: "x", credential: authenticator().create(options.body) } });
  assert.equal(stolen.status, 400);
  const used = await call("POST", "/api/passkeys/register", { cookie: luis.cookie, body: { name: "x", credential: authenticator().create(options.body) } });
  assert.equal(used.status, 400);

  const phishing = authenticator({ origin: "https://evil.test" });
  const fresh = await call("POST", "/api/passkeys/register/options", { cookie: luis.cookie });
  assert.equal((await call("POST", "/api/passkeys/register", { cookie: luis.cookie, body: { name: "x", credential: phishing.create(fresh.body) } })).status, 400);

  // A challenge runs out.
  const late = await call("POST", "/api/passkeys/register/options", { cookie: luis.cookie });
  const realNow = Date.now;
  Date.now = () => realNow() + CHALLENGE_TTL_MS + 1000;
  try {
    assert.equal((await call("POST", "/api/passkeys/register", { cookie: luis.cookie, body: { name: "x", credential: authenticator().create(late.body) } })).status, 400);
  } finally {
    Date.now = realNow;
  }
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM passkeys").get().n, 0);
});

test("signing in with a passkey sets the dashboard session and moves the counter on", async () => {
  await s.account("luis");
  const cookie = await s.cookieFor("luis");
  const key = authenticator();
  assert.equal((await addPasskey(cookie, key)).status, 201);

  const options = await call("POST", "/login/passkey/options");
  assert.equal(options.body.rpId, HOST);
  assert.deepEqual(options.body.allowCredentials ?? [], [], "discoverable, no username needed");

  const login = await call("POST", "/login/passkey", { body: { credential: key.get(options.body) } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.username, "luis");
  const session = login.headers["set-cookie"][0].split(";")[0];
  const me = await call("GET", "/api/me", { cookie: session });
  assert.equal(me.status, 200);
  assert.equal(me.body.username, "luis");
  // The page itself opens too.
  assert.equal((await call("GET", "/", { cookie: session })).status, 200);

  const row = getDb().prepare("SELECT counter, last_used_at FROM passkeys").get();
  assert.equal(row.counter, 1);
  assert.ok(row.last_used_at);
  assert.equal((await call("GET", "/api/passkeys", { cookie })).body[0].lastUsedAt, row.last_used_at);

  assert.equal((await passkeyLogin(key)).status, 200);
  assert.equal(getDb().prepare("SELECT counter FROM passkeys").get().counter, 2);
});

test("a passkey login fails for replays, cloned counters, strangers and someone else's handle", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const key = authenticator();
  await addPasskey(luis.cookie, key);

  const options = await call("POST", "/login/passkey/options");
  const answer = key.get(options.body);
  assert.equal((await call("POST", "/login/passkey", { body: { credential: answer } })).status, 200);
  const replay = await call("POST", "/login/passkey", { body: { credential: answer } });
  assert.equal(replay.status, 401);
  assert.equal(replay.headers["set-cookie"], undefined);

  // A counter that goes back points at a copied key.
  assert.equal((await passkeyLogin(key, { count: 1 })).status, 401);
  assert.equal((await passkeyLogin(authenticator())).status, 401, "unknown passkey");
  assert.equal((await passkeyLogin(key, { count: 10, userHandle: b64u(String(anna.user.id)) })).status, 401);
  assert.equal((await passkeyLogin(key, { count: 11 })).status, 200);
});

test("only the owner sees and deletes a passkey, and a deleted one no longer signs in", async () => {
  const luis = await s.account("luis");
  const anna = await s.account("anna");
  const key = authenticator();
  const { body: passkey } = await addPasskey(luis.cookie, key);

  assert.deepEqual((await call("GET", "/api/passkeys", { cookie: anna.cookie })).body, []);
  assert.equal((await call("DELETE", `/api/passkeys/${passkey.id}`, { cookie: anna.cookie })).status, 404);
  assert.equal((await call("GET", "/api/passkeys")).status, 401);

  assert.equal((await call("DELETE", `/api/passkeys/${passkey.id}`, { cookie: luis.cookie })).status, 204);
  assert.equal((await call("DELETE", `/api/passkeys/${passkey.id}`, { cookie: luis.cookie })).status, 404);
  assert.deepEqual((await call("GET", "/api/passkeys", { cookie: luis.cookie })).body, []);
  assert.equal((await passkeyLogin(key)).status, 401);
});

test("on localhost passkeys work over plain http", async () => {
  config.publicUrl = null;
  const host = "localhost:3012";
  const key = authenticator({ rpId: "localhost", origin: "http://localhost:3012" });
  await s.account("luis");
  const cookie = await s.cookieFor("luis");
  const options = await call("POST", "/api/passkeys/register/options", { cookie, host });
  assert.equal(options.body.rp.id, "localhost");
  assert.equal((await call("POST", "/api/passkeys/register", { cookie, host, body: { name: "Laptop", credential: key.create(options.body) } })).status, 201);
  const login = await call("POST", "/login/passkey/options", { host });
  assert.equal((await call("POST", "/login/passkey", { host, body: { credential: key.get(login.body) } })).status, 200);
});

test("passkey requests have a per-IP limit of their own", async () => {
  await s.stop();
  const max = config.passkeyRateLimit.max;
  config.passkeyRateLimit.max = 3;
  s = await startServer();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/login/passkey/options")).status, 200);
    assert.equal((await call("POST", "/login/passkey/options")).status, 429);
    // The password login counts on its own.
    await s.account("luis");
  } finally {
    config.passkeyRateLimit.max = max;
  }
});

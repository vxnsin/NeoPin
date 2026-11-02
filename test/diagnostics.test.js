import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { startServer } from "./helpers.js";
import { config } from "../src/config.js";
import { diagnosticsDir, listDiagnostics, sweepDiagnostics } from "../src/diagnostics.js";

const originalDbPath = config.dbPath;
const original = { on: config.diagnostics, ttl: config.diagnosticsTtlDays, max: config.diagnosticsRateLimit.max };
let s;
let dir;

// The exports land next to the database, so each test gets a folder of its own.
test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "neopin-diagnostics-test-"));
  config.dbPath = path.join(dir, "neopin.db");
  s = await startServer();
});

test.afterEach(async () => {
  await s.stop();
  config.dbPath = originalDbPath;
  config.diagnostics = original.on;
  config.diagnosticsTtlDays = original.ttl;
  config.diagnosticsRateLimit.max = original.max;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const zip = () => Buffer.from(zipSync({ "summary.json": strToU8('{"app":"neopin"}') }));
const deviceHeaders = (token) => ({ "x-device-id": "phone", authorization: `Bearer ${token}` });
const upload = (body, headers, type = "application/zip") =>
  fetch(`${s.baseUrl}/api/diagnostics`, { method: "POST", headers: { "content-type": type, ...headers }, body });
// Says it sends this many bytes and waits for the answer: the server refuses on the header
// and closes, so fetch would only see the reset while still sending.
const announced = (length, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request(`${s.baseUrl}/api/diagnostics`, {
      method: "POST",
      headers: { "content-type": "application/zip", "content-length": String(length), ...headers },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.write(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
const idOf = (url) => /\/diagnostics\/([0-9a-f]{32})\.zip$/.exec(url)?.[1];

test("the app uploads a zip with its device token and anyone with the link gets it back", async () => {
  const luis = await s.account("luis");
  const res = await upload(zip(), deviceHeaders(luis.token));
  assert.equal(res.status, 201);
  const { url, expiresAt } = await res.json();
  const id = idOf(url);
  assert.ok(id, url);
  assert.ok(url.startsWith(`${s.baseUrl}/diagnostics/`), url);
  const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, String(days));
  assert.ok(fs.existsSync(path.join(diagnosticsDir(), `${id}.zip`)));

  // No cookie, no token: the link is the access.
  const download = await fetch(url);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/zip");
  assert.equal(download.headers.get("cache-control"), "no-store");
  const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
  assert.equal(new TextDecoder().decode(files["summary.json"]), '{"app":"neopin"}');
});

test("PUBLIC_URL makes the link, so one made over the LAN opens from outside", async () => {
  const luis = await s.account("luis");
  const before = config.publicUrl;
  config.publicUrl = "https://neopin.example.com/";
  try {
    const { url } = await (await upload(zip(), deviceHeaders(luis.token))).json();
    assert.match(url, /^https:\/\/neopin\.example\.com\/diagnostics\/[0-9a-f]{32}\.zip$/);
  } finally {
    config.publicUrl = before;
  }
});

test("the dashboard session can upload too, a wrong token or none cannot", async () => {
  const luis = await s.account("luis");
  assert.equal((await upload(zip(), { cookie: luis.cookie })).status, 201);
  assert.equal((await upload(zip(), {})).status, 401);
  assert.equal((await upload(zip(), deviceHeaders("wrong"))).status, 401);
  assert.equal(fs.readdirSync(diagnosticsDir()).filter((n) => n.endsWith(".zip")).length, 1);
});

test("only zips up to 5 MB are taken", async () => {
  const luis = await s.account("luis");
  const auth = deviceHeaders(luis.token);
  assert.equal((await upload(Buffer.from("not a zip at all"), auth)).status, 400);
  assert.equal((await upload(zip(), auth, "application/json")).status, 415);
  assert.equal(await announced(5 * 1024 * 1024 + 1, auth), 413);
  assert.equal(listDiagnostics().length, 0);
});

test("uploads are rate-limited per IP", async () => {
  config.diagnosticsRateLimit.max = 2;
  await s.stop();
  s = await startServer();
  const luis = await s.account("luis");
  const auth = deviceHeaders(luis.token);
  assert.equal((await upload(zip(), auth)).status, 201);
  assert.equal((await upload(zip(), auth)).status, 201);
  assert.equal((await upload(zip(), auth)).status, 429);
});

test("unknown, malformed and expired links are 404, the sweep removes what expired", async () => {
  const luis = await s.account("luis");
  const { url } = await (await upload(zip(), deviceHeaders(luis.token))).json();
  const id = idOf(url);
  assert.equal((await fetch(`${s.baseUrl}/diagnostics/${"0".repeat(32)}.zip`)).status, 404);
  assert.equal((await fetch(`${s.baseUrl}/diagnostics/${id}`)).status, 404);
  assert.equal((await fetch(`${s.baseUrl}/diagnostics/..%2Fneopin.db`)).status, 404);

  // Eight days later.
  const later = Date.now() + 8 * 86_400_000;
  const meta = path.join(diagnosticsDir(), `${id}.json`);
  const stored = JSON.parse(fs.readFileSync(meta, "utf8"));
  fs.writeFileSync(meta, JSON.stringify({ ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.equal((await fetch(url)).status, 404);
  assert.equal(listDiagnostics().length, 0);

  // A fresh one stays, the expired one and a stray zip without metadata go.
  const fresh = idOf((await (await upload(zip(), deviceHeaders(luis.token))).json()).url);
  fs.writeFileSync(path.join(diagnosticsDir(), `${"a".repeat(32)}.zip`), zip());
  assert.equal(await sweepDiagnostics(), 2);
  assert.deepEqual(fs.readdirSync(diagnosticsDir()).sort(), [`${fresh}.json`, `${fresh}.zip`]);
  assert.equal(await sweepDiagnostics(later), 1);
  assert.deepEqual(fs.readdirSync(diagnosticsDir()), []);
});

test("the admin lists and deletes exports, others cannot", async () => {
  const admin = await s.account("boss");
  const luis = await s.account("luis");
  const { url } = await (await upload(zip(), deviceHeaders(luis.token))).json();
  const id = idOf(url);

  const list = (cookie) => fetch(`${s.baseUrl}/api/admin/diagnostics`, { headers: cookie ? { cookie } : {} });
  assert.equal((await list()).status, 401);
  assert.equal((await list(luis.cookie)).status, 403);
  const rows = await (await list(admin.cookie)).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].username, "luis");
  assert.equal(rows[0].deviceId, "phone");
  assert.equal(rows[0].size, zip().length);

  const remove = (target, cookie) => fetch(`${s.baseUrl}/api/admin/diagnostics/${target}`, { method: "DELETE", headers: { cookie } });
  assert.equal((await remove(id, luis.cookie)).status, 403);
  assert.equal((await remove(id, admin.cookie)).status, 204);
  assert.equal((await remove(id, admin.cookie)).status, 404);
  assert.equal((await remove("../neopin", admin.cookie)).status, 404);
  assert.equal((await fetch(url)).status, 404);
  assert.deepEqual(await (await list(admin.cookie)).json(), []);
});

test("DIAGNOSTICS=off turns the upload and the links off", async () => {
  const luis = await s.account("luis");
  const { url } = await (await upload(zip(), deviceHeaders(luis.token))).json();
  config.diagnostics = false;
  assert.equal((await upload(zip(), deviceHeaders(luis.token))).status, 404);
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await (await fetch(`${s.baseUrl}/api/status`)).json()).diagnostics, false);
});

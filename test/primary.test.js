import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";

let s;
let luis;
let tom;

beforeEach(async () => {
  s = await startServer();
  luis = await s.account("luis"); // the first account is the admin
  tom = await s.account("tom");
});

afterEach(() => s.stop());

const put = (route, body, cookie) =>
  fetch(s.baseUrl + route, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

async function devicesOf(cookie) {
  const res = await fetch(`${s.baseUrl}/api/getData`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return res.json();
}

test("nothing is primary until the owner picks a device", async () => {
  const devices = await devicesOf(luis.cookie);
  assert.ok(devices.length > 0);
  assert.ok(devices.every((d) => d.primary === false));
});

test("the owner picks a primary device and can go back to automatic", async () => {
  await s.tokenFor("tom", "ipad");
  const set = await put("/api/me/primary-device", { deviceId: "ipad" }, tom.cookie);
  assert.equal(set.status, 200);
  assert.equal((await set.json()).primaryDeviceId, "ipad");

  const mine = (await devicesOf(luis.cookie)).filter((d) => d.userId === tom.user.id);
  assert.deepEqual(mine.map((d) => [d.deviceId, d.primary]).sort(), [["ipad", true], ["phone", false]]);

  const linked = await (await fetch(`${s.baseUrl}/api/devices`, { headers: { cookie: tom.cookie } })).json();
  assert.equal(linked.find((d) => d.deviceId === "ipad").primary, true);

  const reset = await put("/api/me/primary-device", { deviceId: null }, tom.cookie);
  assert.equal((await reset.json()).primaryDeviceId, null);
});

test("only a device linked to the account can be primary", async () => {
  const res = await put("/api/me/primary-device", { deviceId: "not-mine" }, tom.cookie);
  assert.equal(res.status, 404);
});

test("the admin may pick for others, nobody else may", async () => {
  assert.equal((await put(`/api/users/${luis.user.id}/primary-device`, { deviceId: "phone" }, tom.cookie)).status, 403);
  const res = await put(`/api/users/${tom.user.id}/primary-device`, { deviceId: "phone" }, luis.cookie);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).primaryDeviceId, "phone");
});

test("removing the primary device goes back to automatic", async () => {
  await s.tokenFor("tom", "ipad");
  await put("/api/me/primary-device", { deviceId: "ipad" }, tom.cookie);
  const removed = await fetch(`${s.baseUrl}/api/devices/ipad`, { method: "DELETE", headers: { cookie: tom.cookie } });
  assert.equal(removed.status, 204);
  const me = await (await fetch(`${s.baseUrl}/api/me`, { headers: { cookie: tom.cookie } })).json();
  assert.equal(me.primaryDeviceId, null);
});

test("a device of the account sees the change live", async () => {
  const phone = await s.device("tom", "phone");
  await phone.next();
  await put("/api/me/primary-device", { deviceId: "phone" }, tom.cookie);
  let msg = await phone.next();
  while (!msg.devices?.find((d) => d.deviceId === "phone" && d.userId === tom.user.id)?.primary) msg = await phone.next();
  assert.ok(true);
});

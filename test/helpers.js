import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createUser } from "../src/accounts.js";
import { acceptInvite, createGroup, invite } from "../src/groups.js";
import { initDb, closeDb, getDb } from "../src/db.js";
import { resetDevices } from "../src/devices.js";
import { resetHistoryState } from "../src/history.js";
import { resetPlaceLookups } from "../src/places.js";
import { resetTransitMatches } from "../src/transitMatch.js";
import { resetPaths } from "../src/paths.js";

config.locationWaitMs = 100;
// The real Firebase key in a local .env must not leak into tests, test/push.test.js brings its own.
config.fcmServiceAccountFile = null;
config.fcmServiceAccountJson = null;
// Tests never ask the real Overpass, test/places.test.js brings its own.
config.placeLookupUrl = null;
config.placeFallbackUrl = null;
// Nor the real OSRM, test/paths.test.js brings its own.
config.roadMatchUrl = null;
// Tests log in a lot, and scrypt makes every login slow enough to count.
config.loginRateLimit.max = 30;

export const PASSWORD = "correct-horse";

// A fresh app and an in-memory database per test, so limits and accounts start clean.
export async function startServer() {
  initDb(":memory:");
  resetDevices();
  resetHistoryState();
  resetPlaceLookups();
  resetPaths({ spacing: 0 });
  resetTransitMatches();
  const server = createApp({ gracefulShutdown: false });
  const http = await server.app.listen(0, "127.0.0.1");
  const { port } = http.address();
  const sockets = [];

  const ctx = {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,

    async stop() {
      for (const ws of sockets.splice(0)) ws.close();
      server.stop();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
      closeDb();
    },

    connect(headers) {
      const ws = new WebSocket(ctx.wsUrl, headers ? { headers } : undefined);
      sockets.push(ws);
      const queue = [];
      const waiters = [];
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        const waiter = waiters.shift();
        waiter ? waiter(msg) : queue.push(msg);
      });
      const next = () => new Promise((resolve) => (queue.length ? resolve(queue.shift()) : waiters.push(resolve)));
      const send = (msg) => ws.send(JSON.stringify(msg));
      const closed = new Promise((resolve) =>
        ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }))
      );
      return new Promise((resolve, reject) => {
        ws.addEventListener("open", () => resolve({ ws, next, send, closed }), { once: true });
        ws.addEventListener("error", () => reject(new Error("did not open")), { once: true });
      });
    },

    post: (route, body, headers = {}) =>
      fetch(ctx.baseUrl + route, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),

    // Creates an account and returns what the app and the dashboard need to act as it.
    async account(username = "luis") {
      const user = createUser({ username, password: PASSWORD });
      const login = await ctx.post("/api/auth/login", { username, password: PASSWORD, deviceId: "phone" });
      assert.equal(login.status, 200);
      const { token } = await login.json();
      return { user, token, cookie: await ctx.cookieFor(username) };
    },

    async cookieFor(username, password = PASSWORD) {
      const res = await ctx.post("/login", { username, password });
      assert.equal(res.status, 200);
      return res.headers.get("set-cookie").split(";")[0];
    },

    // Opens a device socket the way the app does, with a token for that device.
    async device(username, deviceId, tokenOwner) {
      const owner = tokenOwner ?? (await ctx.tokenFor(username, deviceId));
      const client = await ctx.connect();
      client.send({ type: "authenticate", deviceId, token: owner });
      const reply = await client.next();
      return { ...client, reply };
    },

    async tokenFor(username, deviceId) {
      const res = await ctx.post("/api/auth/login", { username, password: PASSWORD, deviceId });
      assert.equal(res.status, 200);
      return (await res.json()).token;
    },
  };
  return ctx;
}

// The app percent-encodes both values, header values have to stay ASCII.
export const deviceHeaders = (deviceId, token) => ({
  "x-device-id": encodeURIComponent(deviceId),
  authorization: `Bearer ${encodeURIComponent(token)}`,
});

// Puts the accounts into one new group, the first one owns it.
export function shareGroup(name, ...users) {
  const [owner, ...others] = users;
  const group = createGroup(owner.id, name);
  for (const user of others) acceptInvite(invite(group.id, owner.id, user.username) && invitesOf(group.id, user.id));
  return group;
}

function invitesOf(groupId, userId) {
  // The invite row id, found the same way the API does.
  return Number(
    getDb().prepare("SELECT id FROM group_invites WHERE group_id = ? AND user_id = ?").get(groupId, userId).id
  );
}

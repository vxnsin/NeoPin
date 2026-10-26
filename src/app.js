import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
import { inkan, problem, rateLimit, reply, serveStatic, t } from "@vxnsin/inkan";
import { secureHeaders } from "@inkanjs/secure-headers";
import { config, rootDir } from "./config.js";
import {
  avatarFor,
  clearAvatar,
  createUser,
  deleteUser,
  getUser,
  issueToken,
  linkedDevices,
  listUsers,
  publicUser,
  registrationOpen,
  revokeToken,
  setAvatar,
  unlinkDevice,
  userForToken,
  verifyLogin,
} from "./accounts.js";
import {
  allDevices,
  attachSocket,
  detachSocket,
  getDevice,
  onlineDevices,
  removeDevice,
  serializeDevices,
  updatePosition,
} from "./devices.js";
import { daysWithData, positionsBetween, recordPosition } from "./history.js";
import { createAttemptLimiter } from "./rateLimit.js";
import { sessionPlugin, sessionUserId, signIn } from "./sessions.js";
import { buildTimeline, dayRange } from "./timeline.js";

const CLOSE_POLICY = 4000;
const CLOSE_REPLACED = 4001;
const BROADCAST_THROTTLE_MS = 500;
// The app sends a 128 px JPEG of a few KiB. The cap matches the socket's maxMessage.
const AVATAR_MAX_BYTES = 16 * 1024;
const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
const publicDir = path.join(rootDir, "public");

const Position = t.object({
  latitude: t.number().min(-90).max(90),
  longitude: t.number().min(-180).max(180),
});

const Device = t.object({
  deviceId: t.string(),
  position: Position.nullable(),
  lastPing: t.string().nullable(),
  status: t.enum(["online", "offline"]),
  avatarUrl: t.string().nullable(),
});

const User = t.object({
  id: t.number(),
  username: t.string(),
  displayName: t.string(),
  isAdmin: t.boolean(),
  avatarUrl: t.string().nullable(),
});

const LinkedDevice = t.object({
  deviceId: t.string(),
  linkedAt: t.string(),
  status: t.enum(["online", "offline"]),
  lastPing: t.string().nullable(),
  position: Position.nullable(),
});

const Visit = t.object({
  type: t.literal("visit"),
  start: t.number(),
  end: t.number(),
  durationMs: t.number(),
  lat: t.number(),
  lon: t.number(),
  pointCount: t.number(),
});

const Trip = t.object({
  type: t.literal("trip"),
  start: t.number(),
  end: t.number(),
  durationMs: t.number(),
  distanceM: t.number(),
  mode: t.enum(["walking", "cycling", "driving"]),
  path: t.array(t.array(t.number())),
});

const Timeline = t.object({
  date: t.string(),
  deviceId: t.string(),
  summary: t.object({
    visits: t.number(),
    distanceM: t.number(),
    movingMs: t.number(),
    pointCount: t.number(),
  }),
  segments: t.array(t.union(Visit, Trip)),
});

const Message = t.object({ message: t.string() });

const bare = (type) => t.object({ type: t.literal(type) });

// Everything a client may send over the socket. Anything else closes it with 1007.
const ClientMessage = t.discriminated("type", {
  authenticate: t.object({
    type: t.literal("authenticate"),
    deviceId: t.string().min(1).max(64).optional(),
    token: t.string().max(256).optional(),
    viewer: t.boolean().optional(),
  }),
  updatePosition: Position.extend({ type: t.literal("updatePosition") }),
  locationError: t.object({ type: t.literal("locationError"), message: t.string().max(500).optional() }),
  ping: bare("ping"),
  pong: bare("pong"),
  getData: bare("getData"),
  pingDevices: bare("pingDevices"),
});

// The declared type has to match the first bytes, so nothing but a picture is served back.
function looksLike(type, data) {
  const ascii = (from, to) => data.subarray(from, to).toString("latin1");
  if (type === "image/jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (type === "image/png") return ascii(1, 4) === "PNG";
  if (type === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  return false;
}

function decodeHeader(value) {
  if (typeof value !== "string") return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function send(socket, payload) {
  if (socket?.readyState === 1) socket.send(payload).catch(() => {});
}

// Native apps send no Origin, the dashboard sends its own. A viewer cookie coming
// from any other page is refused.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createApp({ gracefulShutdown = true } = {}) {
  // Dashboard sockets, each with the account it belongs to.
  const viewers = new Map();
  const authFailures = createAttemptLimiter(config.deviceAuthLimit);
  let broadcastTimer = null;
  const dirtyUsers = new Set();

  // Sends the device list to every device and dashboard of the accounts that changed, at most twice a second.
  function broadcastDevices(userId) {
    if (userId !== undefined) dirtyUsers.add(userId);
    else onlineDevices().forEach((d) => dirtyUsers.add(d.userId));
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const users = [...dirtyUsers];
      dirtyUsers.clear();
      for (const id of users) {
        const payload = { type: "dataResponse", devices: serializeDevices(id) };
        for (const device of onlineDevices(id)) send(device.socket, payload);
        for (const [viewer, viewerUser] of viewers) if (viewerUser === id) send(viewer, payload);
      }
    }, BROADCAST_THROTTLE_MS);
  }

  // Asks an account's devices for a fresh fix and resolves once they answered or the wait is over.
  function requestLocation(userId, targetId, excludeId) {
    const targets = onlineDevices(userId).filter(
      (d) => d.id !== excludeId && (!targetId || d.id === targetId)
    );
    const waits = targets.map(
      (device) =>
        new Promise((resolve) => {
          const socket = device.socket;
          const onMessage = (msg) => {
            if (msg.type === "updatePosition") done();
          };
          const done = () => {
            clearTimeout(timer);
            socket.off("message", onMessage);
            resolve();
          };
          const timer = setTimeout(done, config.locationWaitMs);
          socket.on("message", onMessage);
          send(socket, { type: "requestLocation", from: excludeId });
        })
    );
    return Promise.all(waits).then(() => targets.length);
  }

  // The dashboard is signed in with its session cookie, the app with the device
  // token it got at login: the device name in X-Device-Id and the token as a
  // bearer. Both are percent-encoded, because names like "Luis’ iPhone" are no
  // valid header values as they are. Wrong tokens count against the per-IP limit.
  function deviceAuth(ctx) {
    if (authFailures.blocked(ctx.ip)) throw problem(429, "too-many-attempts", "Too many attempts");
    const deviceId = decodeHeader(ctx.headers["x-device-id"]);
    const auth = ctx.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? decodeHeader(auth.slice(7)) : null;
    const user = deviceId && token ? userForToken(token, deviceId) : null;
    if (!user) {
      if (token !== null) authFailures.fail(ctx.ip);
      throw problem(401, "unauthorized", "Log in first");
    }
    return { user, deviceId, token };
  }

  function currentUser(ctx) {
    const id = sessionUserId(ctx.session);
    const user = id === null ? null : getUser(id);
    if (user) return { user, deviceId: null, token: null };
    if (ctx.headers.authorization) return deviceAuth(ctx);
    throw problem(401, "unauthorized", "Log in first");
  }

  function requireAdmin(ctx) {
    const { user } = currentUser(ctx);
    if (!user.is_admin) throw problem(403, "forbidden", "Only the admin can do this");
    return user;
  }

  // Whose data a request is about: the signed-in account, or for the admin any account.
  function targetUserId(ctx, requested) {
    const { user } = currentUser(ctx);
    if (requested === undefined || requested === user.id) return user.id;
    if (!user.is_admin) throw problem(403, "forbidden", "You can only see your own devices");
    if (!getUser(requested)) throw problem(404, "unknown-user", "No such account");
    return requested;
  }

  function linkedDevicesOf(userId) {
    return linkedDevices(userId).map((link) => {
      const live = getDevice(userId, link.deviceId);
      return {
        ...link,
        status: live?.status ?? "offline",
        lastPing: live?.lastPing ?? null,
        position: live?.position ?? null,
      };
    });
  }

  const app = inkan({
    title: "NeoPin Server",
    version: config.version,
    log: false,
    trustProxy: config.trustProxy,
    gracefulShutdown,
  });

  app.register(
    secureHeaders({
      csp: {
        directives: {
          // MapLibre GL comes from unpkg and starts its tile worker from a blob URL.
          "script-src": ["'self'", "https://unpkg.com"],
          "worker-src": ["'self'", "blob:"],
          "child-src": ["blob:"],
          // MapLibre positions its markers and controls with inline styles. Scripts stay strict.
          "style-src": ["'self'", "'unsafe-inline'", "https://unpkg.com"],
          "img-src": ["'self'", "data:", "blob:"],
          // Style, vector tiles, glyphs and sprites all come from OpenFreeMap.
          "connect-src": ["'self'", "https://tiles.openfreemap.org"],
        },
      },
      // The tile host may see which site loads its tiles, nothing more.
      referrerPolicy: "strict-origin-when-cross-origin",
    })
  );
  app.register(sessionPlugin());

  // The two pages get their own routes, so "/" can send anyone without a session to the login.
  const page = async (name) =>
    reply(200, await fs.readFile(path.join(publicDir, name)), {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });

  const signedIn = (ctx) => {
    const id = sessionUserId(ctx.session);
    return id !== null && getUser(id) !== null;
  };

  app.get("/", (ctx) => (signedIn(ctx) ? page("index.html") : ctx.redirect("/login")));
  app.get("/index.html", (ctx) => ctx.redirect("/"));
  app.get("/login", () => page("login.html"));
  // Old links and bookmarks still find the login.
  app.get("/login.html", (ctx) => ctx.redirect("/login"));
  app.register(serveStatic({ dir: path.join(publicDir, "assets"), prefix: "/assets", immutable: () => false }));

  // What the login screens need before anyone is signed in.
  app.get(
    "/api/status",
    { response: { 200: t.object({ version: t.string(), registrationOpen: t.boolean() }) } },
    () => ({ version: config.version, registrationOpen: registrationOpen() })
  );

  // Everything that takes a password shares one limit per IP.
  app.register((scope) => {
    scope.register(rateLimit({ max: config.loginRateLimit.max, window: config.loginRateLimit.windowMs }));

    // Dashboard login: sets the session cookie.
    scope.post(
      "/login",
      {
        body: t.object({ username: t.string().max(64), password: t.string().max(256) }),
        response: { 200: t.object({ message: t.string(), user: User }), 401: t.problem(), 429: t.problem() },
      },
      (ctx) => {
        const user = verifyLogin(ctx.body.username, ctx.body.password);
        if (!user) throw problem(401, "invalid-credentials", "Wrong username or password");
        signIn(ctx.session, user.id);
        return { message: "Login successful", user: publicUser(user) };
      }
    );

    // App login: answers with the token the device uses from now on.
    scope.post(
      "/api/auth/login",
      {
        body: t.object({
          username: t.string().max(64),
          password: t.string().max(256),
          deviceId: t.string().min(1).max(64),
        }),
        response: { 200: t.object({ token: t.string(), user: User }), 401: t.problem(), 429: t.problem() },
      },
      (ctx) => {
        const user = verifyLogin(ctx.body.username, ctx.body.password);
        if (!user) throw problem(401, "invalid-credentials", "Wrong username or password");
        return { token: issueToken(user.id, ctx.body.deviceId), user: publicUser(user) };
      }
    );

    scope.post(
      "/api/register",
      {
        body: t.object({
          username: t.string().max(64),
          password: t.string().max(256),
          displayName: t.string().max(64).optional(),
        }),
        response: { 201: User, 400: t.problem(), 403: t.problem(), 409: t.problem(), 429: t.problem() },
      },
      (ctx) => {
        if (!registrationOpen()) throw problem(403, "registration-closed", "Accounts are created by the admin");
        try {
          const user = createUser(ctx.body);
          console.log(chalk.cyan(`[i] Account ${chalk.whiteBright(user.username)} created.`));
          return reply(201, publicUser(user));
        } catch (error) {
          if (error.code === "taken") throw problem(409, "username-taken", error.message);
          if (error.code === "invalid") throw problem(400, "invalid-account", error.message);
          throw error;
        }
      }
    );
  });

  app.get("/logout", (ctx) => {
    ctx.session.destroy();
    return ctx.redirect("/login");
  });

  app.register(
    (api) => {
      api.get("/me", { response: { 200: User, 401: t.problem() } }, (ctx) => publicUser(currentUser(ctx).user));

      // Every device that is linked to the account, connected or not.
      api.get("/devices", { response: { 200: t.array(LinkedDevice), 401: t.problem() } }, (ctx) =>
        linkedDevicesOf(currentUser(ctx).user.id)
      );

      api.delete(
        "/devices/:deviceId",
        { response: { 204: t.empty(), 401: t.problem(), 404: t.problem() } },
        (ctx) => {
          const { user } = currentUser(ctx);
          if (!unlinkDevice(user.id, ctx.params.deviceId)) throw problem(404, "unknown-device", "No such linked device");
          getDevice(user.id, ctx.params.deviceId)?.socket?.close(CLOSE_POLICY, "Device removed");
          removeDevice(user.id, ctx.params.deviceId);
          broadcastDevices(user.id);
          return reply(204);
        }
      );

      // Account management, for the admin (the first account).
      api.get(
        "/users",
        { response: { 200: t.array(User.extend({ devices: t.number() })), 401: t.problem(), 403: t.problem() } },
        (ctx) => {
          requireAdmin(ctx);
          return listUsers().map((u) => ({ ...publicUser(u), devices: linkedDevices(u.id).length }));
        }
      );

      // The admin looks at the devices of any account, e.g. to open their timeline.
      api.get(
        "/users/:id/devices",
        { response: { 200: t.array(LinkedDevice), 401: t.problem(), 403: t.problem(), 404: t.problem() } },
        (ctx) => {
          requireAdmin(ctx);
          const id = Number(ctx.params.id);
          if (!getUser(id)) throw problem(404, "unknown-user", "No such account");
          return linkedDevicesOf(id);
        }
      );

      api.post(
        "/users",
        {
          body: t.object({
            username: t.string().max(64),
            password: t.string().max(256),
            displayName: t.string().max(64).optional(),
          }),
          response: { 201: User, 400: t.problem(), 401: t.problem(), 403: t.problem(), 409: t.problem() },
        },
        (ctx) => {
          requireAdmin(ctx);
          try {
            const user = createUser(ctx.body);
            console.log(chalk.cyan(`[i] Account ${chalk.whiteBright(user.username)} created in the dashboard.`));
            return reply(201, publicUser(user));
          } catch (error) {
            if (error.code === "taken") throw problem(409, "username-taken", error.message);
            if (error.code === "invalid") throw problem(400, "invalid-account", error.message);
            throw error;
          }
        }
      );

      api.delete(
        "/users/:id",
        { response: { 204: t.empty(), 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem() } },
        (ctx) => {
          const admin = requireAdmin(ctx);
          const target = getUser(Number(ctx.params.id));
          if (!target) throw problem(404, "unknown-user", "No such account");
          if (target.id === admin.id) throw problem(400, "own-account", "The admin cannot remove itself");
          disconnectAccount(target.id, "Account removed");
          for (const device of allDevices(target.id)) removeDevice(target.id, device.id);
          deleteUser(target.id);
          return reply(204);
        }
      );

      api.post(
        "/auth/logout",
        { response: { 200: Message, 401: t.problem() } },
        (ctx) => {
          const { token } = deviceAuth(ctx);
          revokeToken(token);
          return { message: "Logged out" };
        }
      );

      api.get("/getData", { response: { 200: t.array(Device), 401: t.problem() } }, (ctx) =>
        serializeDevices(currentUser(ctx).user.id)
      );

      api.post(
        "/sendPing",
        {
          body: t.object({ deviceId: t.string().max(64).optional() }).optional(),
          response: {
            200: t.object({ message: t.string(), devices: t.array(Device) }),
            202: Message,
            401: t.problem(),
            404: t.problem(),
          },
        },
        async (ctx) => {
          const userId = currentUser(ctx).user.id;
          const deviceId = ctx.body?.deviceId;
          if (onlineDevices(userId).length === 0) return reply(202, { message: "No devices connected" });
          if (deviceId && !getDevice(userId, deviceId)?.socket) {
            throw problem(404, "device-not-connected", `Device ${deviceId} is not connected`);
          }
          const asked = await requestLocation(userId, deviceId || null, null);
          broadcastDevices(userId);
          return {
            message: deviceId ? `Location request sent to ${deviceId}` : `Location request sent to ${asked} devices`,
            devices: serializeDevices(userId),
          };
        }
      );

      // The day view: stays and trips, built from the stored fixes of one device.
      api.get(
        "/timeline",
        {
          query: t.object({
            deviceId: t.string().max(64),
            date: t.string().max(10),
            tz: t.number().optional(),
            userId: t.number().optional(),
          }),
          response: { 200: Timeline, 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem() },
        },
        (ctx) => {
          const userId = targetUserId(ctx, ctx.query.userId);
          const range = dayRange(ctx.query.date, ctx.query.tz ?? 0);
          if (!range) throw problem(400, "bad-date", "date has to look like 2025-01-31");
          const points = positionsBetween(userId, ctx.query.deviceId, range.from, range.to);
          return { date: ctx.query.date, deviceId: ctx.query.deviceId, ...buildTimeline(points) };
        }
      );

      // Which days have anything to show.
      api.get(
        "/timeline/days",
        {
          query: t.object({ deviceId: t.string().max(64), tz: t.number().optional(), userId: t.number().optional() }),
          response: { 200: t.array(t.string()), 401: t.problem(), 403: t.problem(), 404: t.problem() },
        },
        (ctx) => daysWithData(targetUserId(ctx, ctx.query.userId), ctx.query.deviceId, ctx.query.tz ?? 0)
      );
    },
    {},
    { prefix: "/api" }
  );

  // Profile pictures belong to the account. Set from the app or the dashboard, read by both.
  app.register((avatars) => {
    avatars.register(rateLimit({ max: config.avatarRateLimit.max, window: config.avatarRateLimit.windowMs }));

    avatars.put(
      "/api/avatar",
      {
        body: t.binary().max(AVATAR_MAX_BYTES).accept(...AVATAR_TYPES),
        response: {
          200: t.object({ avatarUrl: t.string() }),
          400: t.problem(),
          401: t.problem(),
          413: t.problem(),
          415: t.problem(),
          429: t.problem(),
        },
      },
      (ctx) => {
        const { user } = currentUser(ctx);
        const type = String(ctx.headers["content-type"]).split(";")[0].trim().toLowerCase();
        if (!looksLike(type, ctx.body)) throw problem(400, "not-an-image", `The body is no ${type}`);
        const updated = setAvatar(user.id, Buffer.from(ctx.body), type);
        console.log(chalk.cyan(`[i] ${chalk.whiteBright(user.username)} has a new profile picture.`));
        broadcastDevices(user.id);
        return { avatarUrl: publicUser(updated).avatarUrl };
      }
    );

    avatars.delete(
      "/api/avatar",
      { response: { 204: t.empty(), 401: t.problem(), 429: t.problem() } },
      (ctx) => {
        const { user } = currentUser(ctx);
        clearAvatar(user.id);
        broadcastDevices(user.id);
        return reply(204);
      }
    );

    avatars.get("/avatars/:userId", (ctx) => {
      const { user } = currentUser(ctx);
      const avatar = String(user.id) === ctx.params.userId ? avatarFor(user.id) : null;
      if (!avatar) throw problem(404, "no-avatar", "No profile picture");
      return reply(200, avatar.data, {
        "content-type": avatar.type,
        // The URL carries the version, a new picture gets a new URL.
        "cache-control": "private, max-age=31536000, immutable",
      });
    });
  });

  app.ws(
    "/",
    { origins: "*", message: ClientMessage, maxMessage: 16 * 1024, heartbeat: config.heartbeatMs },
    (socket, ctx) => {
      let account = null;
      let deviceId = null;
      let role = null;

      const refuse = (reason) => socket.close(CLOSE_POLICY, reason);

      const authenticate = (msg) => {
        if (msg.type !== "authenticate") return refuse("Unauthorized");

        if (msg.viewer) {
          const id = sessionUserId(ctx.session);
          if (id === null || !getUser(id) || !sameOrigin(ctx.req)) return refuse("Unauthorized");
          role = "viewer";
          account = id;
          viewers.set(socket, id);
          send(socket, { successful: true });
          send(socket, { type: "dataResponse", devices: serializeDevices(id) });
          return;
        }

        if (authFailures.blocked(ctx.ip)) return refuse("Too many attempts");
        const user = msg.deviceId && msg.token ? userForToken(msg.token, msg.deviceId) : null;
        if (!user) {
          authFailures.fail(ctx.ip);
          console.log(
            chalk.red(`[Failed] Unauthorized connection attempt from ${chalk.whiteBright(msg.deviceId || "Unknown")}`)
          );
          return refuse("Unauthorized");
        }

        deviceId = msg.deviceId;
        account = user.id;
        role = "device";
        const replaced = attachSocket(account, deviceId, socket);
        const label = `${chalk.whiteBright(user.username)}/${chalk.whiteBright(deviceId)}`;
        if (replaced) {
          console.log(chalk.yellow(`[i] Device ${label} reconnected. Replacing the previous connection.`));
          replaced.replaced = true;
          replaced.close(CLOSE_REPLACED, "Replaced by a newer connection");
        } else {
          console.log(chalk.greenBright(`[+] Device ${label} connected.`));
        }
        send(socket, { successful: true });
        broadcastDevices(account);
      };

      const handle = async (msg) => {
        switch (msg.type) {
          case "ping":
            send(socket, { type: "pong" });
            break;
          case "getData":
            send(socket, { type: "dataResponse", devices: serializeDevices(account) });
            break;
          case "pingDevices":
            await requestLocation(account, null, deviceId);
            send(socket, { type: "dataResponse", devices: serializeDevices(account) });
            break;
          case "updatePosition":
            if (role !== "device") return;
            updatePosition(account, deviceId, msg.latitude, msg.longitude);
            recordPosition(account, deviceId, msg.latitude, msg.longitude);
            broadcastDevices(account);
            break;
          case "locationError":
            console.log(chalk.yellow(`[!] ${chalk.whiteBright(deviceId)} could not read its location: ${msg.message}`));
            break;
        }
      };

      socket.on("message", (msg) => {
        if (!role) return authenticate(msg);
        handle(msg).catch((error) => console.error("Error handling message:", error));
      });

      socket.on("close", () => {
        if (role === "viewer") {
          viewers.delete(socket);
          return;
        }
        if (role === "device" && !socket.replaced && detachSocket(account, deviceId, socket)) {
          console.log(chalk.redBright(`[-] Device ${chalk.whiteBright(deviceId)} disconnected. Marked offline.`));
          broadcastDevices(account);
        }
      });
    }
  );

  function disconnectAccount(userId, reason) {
    for (const device of onlineDevices(userId)) device.socket.close(CLOSE_POLICY, reason);
    for (const [viewer, id] of viewers) if (userId === undefined || id === userId) viewer.close(CLOSE_POLICY, reason);
  }

  return {
    app,
    broadcastDevices,
    requestLocation,
    disconnectDevice(userId, id, reason = "Disconnected by server") {
      getDevice(userId, id)?.socket?.close(CLOSE_POLICY, reason);
    },
    // Closes every device socket and dashboard of one account, or of everyone.
    disconnectUser(userId, reason = "Logged out by server") {
      disconnectAccount(userId, reason);
    },
    resetAuthFailures: () => authFailures.reset(),
    stop() {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
      dirtyUsers.clear();
    },
  };
}

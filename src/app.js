import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
import { inkan, problem, rateLimit, reply, serveStatic, t } from "@vxnsin/inkan";
import { secureHeaders } from "@inkanjs/secure-headers";
import { config, passwordMatches, rootDir } from "./config.js";
import {
  attachSocket,
  avatarUrl,
  clearAvatar,
  detachSocket,
  getDevice,
  onlineDevices,
  serializeDevices,
  setAvatar,
  updatePosition,
} from "./devices.js";
import { createAttemptLimiter } from "./rateLimit.js";
import { isSignedIn, sessionPlugin, signIn } from "./sessions.js";

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

const Message = t.object({ message: t.string() });

const bare = (type) => t.object({ type: t.literal(type) });

// Everything a client may send over the socket. Anything else closes it with 1007.
const ClientMessage = t.discriminated("type", {
  authenticate: t.object({
    type: t.literal("authenticate"),
    deviceId: t.string().min(1).max(64).optional(),
    password: t.string().max(256).optional(),
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
  const viewers = new Set();
  const authFailures = createAttemptLimiter(config.deviceAuthLimit);
  let broadcastTimer = null;

  // Sends the current device list to every device and dashboard, at most twice a second.
  function broadcastDevices() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const payload = { type: "dataResponse", devices: serializeDevices() };
      for (const device of onlineDevices()) send(device.socket, payload);
      for (const viewer of viewers) send(viewer, payload);
    }, BROADCAST_THROTTLE_MS);
  }

  // Asks devices for a fresh fix and resolves once they answered or the wait is over.
  function requestLocation(targetId, excludeId) {
    const targets = onlineDevices().filter(
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

  // Devices speak HTTP with the same password as on the socket: the device id in
  // X-Device-Id, the password as a bearer token. Wrong guesses count against the
  // same per-IP limit as failed socket logins. Both are percent-encoded, because
  // names like "Luis’ iPhone" are no valid header values as they are.
  function deviceFromHeaders(ctx) {
    if (authFailures.blocked(ctx.ip)) throw problem(429, "too-many-attempts", "Too many attempts");
    const deviceId = decodeHeader(ctx.headers["x-device-id"]);
    const auth = ctx.headers.authorization;
    const password = typeof auth === "string" && auth.startsWith("Bearer ") ? decodeHeader(auth.slice(7)) : null;
    if (typeof deviceId !== "string" || !deviceId || !passwordMatches(password)) {
      if (password !== null) authFailures.fail(ctx.ip);
      throw problem(401, "unauthorized", "Send X-Device-Id and the server password as a bearer token");
    }
    const device = getDevice(deviceId);
    if (!device) throw problem(404, "unknown-device", `Device ${deviceId} has never connected`);
    return device;
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

  app.get("/", (ctx) => (isSignedIn(ctx.session) ? page("index.html") : ctx.redirect("/login.html")));
  app.get("/index.html", (ctx) => ctx.redirect("/"));
  app.get("/login.html", () => page("login.html"));
  app.register(serveStatic({ dir: path.join(publicDir, "assets"), prefix: "/assets", immutable: () => false }));

  app.register((scope) => {
    scope.register(rateLimit({ max: config.loginRateLimit.max, window: config.loginRateLimit.windowMs }));
    scope.post(
      "/login",
      {
        body: t.object({ password: t.string().max(256) }),
        response: { 200: Message, 401: t.problem(), 429: t.problem() },
      },
      (ctx) => {
        if (!passwordMatches(ctx.body.password)) throw problem(401, "invalid-password", "Invalid password");
        signIn(ctx.session);
        return { message: "Login successful" };
      }
    );
  });

  app.get("/logout", (ctx) => {
    ctx.session.destroy();
    return ctx.redirect("/login.html");
  });

  app.register(
    (api) => {
      api.onRequest((ctx) => {
        if (!isSignedIn(ctx.session)) throw problem(401, "unauthorized", "Log in first");
      });

      api.get("/getData", { response: { 200: t.array(Device), 401: t.problem() } }, () => serializeDevices());

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
          const deviceId = ctx.body?.deviceId;
          if (onlineDevices().length === 0) return reply(202, { message: "No devices connected" });
          if (deviceId && !getDevice(deviceId)?.socket) {
            throw problem(404, "device-not-connected", `Device ${deviceId} is not connected`);
          }
          const asked = await requestLocation(deviceId || null, null);
          broadcastDevices();
          return {
            message: deviceId ? `Location request sent to ${deviceId}` : `Location request sent to ${asked} devices`,
            devices: serializeDevices(),
          };
        }
      );
    },
    {},
    { prefix: "/api" }
  );

  // Profile pictures: the device uploads its own, the dashboard and other devices read them.
  app.register(
    (avatars) => {
      avatars.register(rateLimit({ max: config.avatarRateLimit.max, window: config.avatarRateLimit.windowMs }));

      avatars.put(
        "/api/avatar",
        {
          body: t.binary().max(AVATAR_MAX_BYTES).accept(...AVATAR_TYPES),
          response: {
            200: t.object({ avatarUrl: t.string() }),
            400: t.problem(),
            401: t.problem(),
            404: t.problem(),
            413: t.problem(),
            415: t.problem(),
            429: t.problem(),
          },
        },
        (ctx) => {
          const device = deviceFromHeaders(ctx);
          const type = String(ctx.headers["content-type"]).split(";")[0].trim().toLowerCase();
          if (!looksLike(type, ctx.body)) throw problem(400, "not-an-image", `The body is no ${type}`);
          setAvatar(device.id, Buffer.from(ctx.body), type);
          console.log(chalk.cyan(`[i] Device ${chalk.whiteBright(device.id)} has a new profile picture.`));
          broadcastDevices();
          return { avatarUrl: avatarUrl(device) };
        }
      );

      avatars.delete(
        "/api/avatar",
        { response: { 204: t.empty(), 401: t.problem(), 404: t.problem(), 429: t.problem() } },
        (ctx) => {
          clearAvatar(deviceFromHeaders(ctx).id);
          broadcastDevices();
          return reply(204);
        }
      );

      avatars.get("/avatars/:deviceId", (ctx) => {
        if (!isSignedIn(ctx.session)) deviceFromHeaders(ctx);
        const avatar = getDevice(ctx.params.deviceId)?.avatar;
        if (!avatar) throw problem(404, "no-avatar", "This device has no profile picture");
        return reply(200, avatar.data, {
          "content-type": avatar.type,
          // The URL carries the version, a new picture gets a new URL.
          "cache-control": "private, max-age=31536000, immutable",
        });
      });
    }
  );

  app.ws(
    "/",
    { origins: "*", message: ClientMessage, maxMessage: 16 * 1024, heartbeat: config.heartbeatMs },
    (socket, ctx) => {
      let deviceId = null;
      let role = null;

      const refuse = (reason) => socket.close(CLOSE_POLICY, reason);

      const authenticate = (msg) => {
        if (msg.type !== "authenticate") return refuse("Unauthorized");

        if (msg.viewer) {
          if (!isSignedIn(ctx.session) || !sameOrigin(ctx.req)) return refuse("Unauthorized");
          role = "viewer";
          viewers.add(socket);
          send(socket, { successful: true });
          send(socket, { type: "dataResponse", devices: serializeDevices() });
          return;
        }

        if (authFailures.blocked(ctx.ip)) return refuse("Too many attempts");
        if (!msg.deviceId || !passwordMatches(msg.password)) {
          authFailures.fail(ctx.ip);
          console.log(
            chalk.red(`[Failed] Unauthorized connection attempt from ${chalk.whiteBright(msg.deviceId || "Unknown")}`)
          );
          return refuse("Unauthorized");
        }

        deviceId = msg.deviceId;
        role = "device";
        const replaced = attachSocket(deviceId, socket);
        if (replaced) {
          console.log(chalk.yellow(`[i] Device ${chalk.whiteBright(deviceId)} reconnected. Replacing the previous connection.`));
          replaced.replaced = true;
          replaced.close(CLOSE_REPLACED, "Replaced by a newer connection");
        } else {
          console.log(chalk.greenBright(`[+] Device ${chalk.whiteBright(deviceId)} connected.`));
        }
        send(socket, { successful: true });
        broadcastDevices();
      };

      const handle = async (msg) => {
        switch (msg.type) {
          case "ping":
            send(socket, { type: "pong" });
            break;
          case "getData":
            send(socket, { type: "dataResponse", devices: serializeDevices() });
            break;
          case "pingDevices":
            await requestLocation(null, deviceId);
            send(socket, { type: "dataResponse", devices: serializeDevices() });
            break;
          case "updatePosition":
            if (role !== "device") return;
            updatePosition(deviceId, msg.latitude, msg.longitude);
            broadcastDevices();
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
        if (role === "device" && !socket.replaced && detachSocket(deviceId, socket)) {
          console.log(chalk.redBright(`[-] Device ${chalk.whiteBright(deviceId)} disconnected. Marked offline.`));
          broadcastDevices();
        }
      });
    }
  );

  return {
    app,
    broadcastDevices,
    requestLocation,
    disconnectDevice(id, reason = "Disconnected by server") {
      getDevice(id)?.socket?.close(CLOSE_POLICY, reason);
    },
    disconnectAllDevices(reason) {
      for (const device of onlineDevices()) device.socket.close(CLOSE_POLICY, reason);
    },
    resetAuthFailures: () => authFailures.reset(),
    stop() {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    },
  };
}

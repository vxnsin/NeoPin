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
  searchUsers,
  revokeToken,
  setPassword,
  setAvatar,
  setPrimaryDevice,
  unlinkDevice,
  updateUser,
  userForToken,
  verifyLogin,
  HIDDEN_FOREVER,
  hiddenSpans,
  hiddenUntilOf,
  isHidden,
  setHiddenUntil,
} from "./accounts.js";
import {
  allDevices,
  attachSocket,
  detachSocket,
  getDevice,
  onlineDevices,
  removeDevice,
  statusOf,
  serializeDevices,
  updateBattery,
  updatePosition,
} from "./devices.js";
import {
  acceptInvite,
  audience,
  cancelInvite,
  canManage,
  canSee,
  createGroup,
  deleteGroup,
  getGroup,
  getInvite,
  groupsFor,
  invite,
  invitesFor,
  isFixed,
  isMember,
  joinFixedGroups,
  removeMember,
  renameGroup,
} from "./groups.js";
import { createInvite, getInviteCode, inviteSummary, inviteView, listInvites, registerWithCode, revokeInvite } from "./invites.js";
import { markRead, notificationsFor } from "./notifications.js";
import { daysWithData, dismissVisit, dismissedVisits, positionsBetween, recordPosition, restoreVisit } from "./history.js";
import { FIND_PUSH_COOLDOWN_MS, createFinder } from "./find.js";
import { fcmEnabled, sendNotification, sendWakeUp } from "./fcm.js";
import { PUSH_PLATFORMS, deletePushToken, pushTokenOf, pushTokensOf, setPushToken } from "./push.js";
import { createAttemptLimiter } from "./rateLimit.js";
import { sessionPlugin, sessionUserId, signIn } from "./sessions.js";
import { buildTimeline, dayRange } from "./timeline.js";
import { SHARING_MODES, canSeeTimeline, saveTimelineSharing, timelinePeople, timelineSharing, withoutSpans } from "./sharing.js";
import { transitStatus } from "./transit.js";
import { TRANSIT_KINDS, TRIP_MODES, matchTransit, setTripMode } from "./transitMatch.js";
import { smoothPaths } from "./paths.js";
import {
  MAX_RADIUS_M,
  MIN_RADIUS_M,
  PLACE_KINDS,
  TAG_KINDS,
  claimSpot,
  deletePlace,
  listPlaces,
  namePlaces,
  placeChoices,
  savePlaceAt,
  updatePlace,
} from "./places.js";

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

const DeviceType = t.enum(["phone", "tablet", "desktop"]);

// What the app reports about its battery: the charge in percent and whether it is plugged in.
const Battery = t.object({
  level: t.int().min(0).max(100),
  charging: t.boolean(),
});

const Device = t.object({
  deviceId: t.string(),
  userId: t.number(),
  groupIds: t.array(t.number()),
  owner: t.object({ username: t.string(), displayName: t.string() }),
  position: Position.nullable(),
  lastPing: t.string().nullable(),
  status: t.enum(["online", "offline"]),
  battery: Battery.extend({ updatedAt: t.string() }).nullable(),
  avatarUrl: t.string().nullable(),
  deviceType: DeviceType,
  primary: t.boolean(),
});

const User = t.object({
  id: t.number(),
  username: t.string(),
  displayName: t.string(),
  isAdmin: t.boolean(),
  mustChangePassword: t.boolean(),
  avatarUrl: t.string().nullable(),
  primaryDeviceId: t.string().nullable(),
});

// The account itself, with what only it sees: until when it hides (ms), null when visible.
const Me = User.extend({ hiddenUntil: t.number().nullable() });
const meOf = (user) => ({ ...publicUser(user), hiddenUntil: hiddenUntilOf(user) });

const LinkedDevice = t.object({
  deviceId: t.string(),
  linkedAt: t.string(),
  deviceType: DeviceType,
  primary: t.boolean(),
  status: t.enum(["online", "offline"]),
  lastPing: t.string().nullable(),
  position: Position.nullable(),
});

// Where a visit was: an own place (named or confirmed) or a guess from OpenStreetMap.
const VisitPlace = t.object({
  id: t.number().nullable(),
  name: t.string(),
  kind: t.enum(PLACE_KINDS),
  source: t.enum(["own", "osm"]),
  osmId: t.string().nullable(),
});

const Place = t.object({
  id: t.number(),
  name: t.string(),
  kind: t.enum(PLACE_KINDS),
  lat: t.number(),
  lon: t.number(),
  radiusM: t.number(),
  osmId: t.string().nullable(),
});

const PlaceName = t.string().min(1).max(80);
const PlaceRadius = t.int().min(MIN_RADIUS_M).max(MAX_RADIUS_M);

const Visit = t.object({
  type: t.literal("visit"),
  start: t.number(),
  end: t.number(),
  durationMs: t.number(),
  lat: t.number(),
  lon: t.number(),
  pointCount: t.number(),
  place: VisitPlace.nullable(),
});

const TransitStop = t.object({ name: t.string(), lat: t.number(), lon: t.number() });

// Which line a trip was: from the timetables (gtfs), or from OpenStreetMap (osm) with fewer details.
const Transit = t.object({
  kind: t.enum(TRANSIT_KINDS),
  line: t.string(),
  headsign: t.string().nullable(),
  color: t.string().nullable(),
  textColor: t.string().nullable(),
  agency: t.string().nullable(),
  from: TransitStop,
  to: TransitStop,
  source: t.enum(["gtfs", "osm"]),
});

const Trip = t.object({
  type: t.literal("trip"),
  start: t.number(),
  end: t.number(),
  durationMs: t.number(),
  distanceM: t.number(),
  mode: t.enum(TRIP_MODES),
  path: t.array(t.array(t.number())),
  // No fixes on the way: only where it started and ended is known.
  gap: t.boolean().optional(),
  // On a transit trip: the line, or null when the person said "transit" and no line is known.
  transit: Transit.nullable().optional(),
  // The person corrected the mode (PUT /api/trips/mode).
  corrected: t.boolean().optional(),
  // Where `path` comes from when it is not the fixes themselves: the line's course between
  // the stops, or the fixes snapped to the roads.
  pathSource: t.enum(["line", "road"]).optional(),
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
  // Some place names are still being looked up, a reload in a few seconds has them.
  placesPending: t.boolean(),
  // Some trips are still being snapped to the roads, a reload in a few seconds has them.
  pathsPending: t.boolean(),
  // Stops the person dismissed on this day, so the clients can bring one back.
  dismissed: t.array(t.object({ start: t.number(), end: t.number() })),
});

const Message = t.object({ message: t.string() });

const bare = (type) => t.object({ type: t.literal(type) });

// What the GPS knows about a fix besides where it is: when it was taken (ms since the
// epoch), how exact it is (m) and how fast the phone moved (m/s, -1 when unknown).
const FixDetails = {
  recordedAt: t.int().min(0).optional(),
  accuracy: t.number().min(0).max(100_000).optional(),
  speed: t.number().min(-1).max(200).optional(),
};

// The phone's time of a fix, unless its clock is off: then the server's.
function fixTime(recordedAt, now = Date.now()) {
  if (!recordedAt || recordedAt > now + 60_000 || recordedAt < now - 7 * 86_400_000) return now;
  return Math.min(recordedAt, now);
}

const fixExtras = (fix) => ({ accuracy: fix.accuracy ?? null, speed: fix.speed >= 0 ? fix.speed : null });

// Everything a client may send over the socket. Anything else closes it with 1007.
const ClientMessage = t.discriminated("type", {
  authenticate: t.object({
    type: t.literal("authenticate"),
    deviceId: t.string().min(1).max(64).optional(),
    token: t.string().max(256).optional(),
    deviceType: DeviceType.optional(),
    // How often the app means to report, in ms, from its update preset.
    interval: t.int().min(1000).max(60 * 60 * 1000).optional(),
    viewer: t.boolean().optional(),
  }),
  // The battery rides along with a position; on its own it comes when only the charge changed.
  updatePosition: Position.extend({ type: t.literal("updatePosition"), battery: Battery.optional(), ...FixDetails }),
  // Fixes the app collected while it had no connection, oldest first. At most 100 per
  // message, so a batch stays below the socket's 16 KiB.
  positionBatch: t.object({ type: t.literal("positionBatch"), points: t.array(Position.extend(FixDetails)).max(100) }),
  updateBattery: Battery.extend({ type: t.literal("updateBattery") }),
  locationError: t.object({ type: t.literal("locationError"), message: t.string().max(500).optional() }),
  ping: bare("ping"),
  pong: bare("pong"),
  getData: bare("getData"),
  pingDevices: bare("pingDevices"),
  // "Find me": ask an account, answer, share positions with the other side, stop.
  findRequest: t.object({ type: t.literal("findRequest"), userId: t.int().min(1) }),
  findAnswer: t.object({ type: t.literal("findAnswer"), session: t.string().max(32), accept: t.boolean() }),
  findPosition: Position.extend({
    type: t.literal("findPosition"),
    session: t.string().max(32),
    accuracy: t.number().min(0).max(100_000).optional(),
    // Which way the phone points, degrees from north, so the other side can show an arrow.
    heading: t.number().min(0).max(360).optional(),
  }),
  // "met": the phones saw each other over Bluetooth, the search is over because it worked.
  findEnd: t.object({ type: t.literal("findEnd"), session: t.string().max(32), reason: t.enum(["ended", "met"]).optional() }),
});

// What a phone needs to know about the other side of a find session.
const peerOf = (userId) => {
  const { id, username, displayName, avatarUrl } = publicUser(getUser(userId));
  return { id, username, displayName, avatarUrl };
};

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

  const sendTo = (userId, deviceId, payload) => send(getDevice(userId, deviceId)?.socket, payload);

  // Who waits for a device to report a position, by "userId:deviceId".
  const positionWaiters = new Map();
  const reported = (userId, deviceId) => {
    const key = `${userId}:${deviceId}`;
    for (const resolve of positionWaiters.get(key) ?? []) resolve(true);
    positionWaiters.delete(key);
  };
  // `done` resolves true when the device reports within the time, false when the time runs out
  // or `cancel` is called. Register before waking the device, so a fast answer is not missed.
  function waitForPosition(userId, deviceId, ms) {
    const key = `${userId}:${deviceId}`;
    let finish;
    const done = new Promise((resolve) => {
      const waiters = positionWaiters.get(key) ?? new Set();
      positionWaiters.set(key, waiters);
      finish = (value) => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0 && positionWaiters.get(key) === waiters) positionWaiters.delete(key);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), ms);
      waiters.add(finish);
    });
    return { done, cancel: () => finish(false) };
  }

  // The device a viewer may ask, that has no open socket, a push token, and is not hidden.
  function wakeTarget(viewer, deviceId, userId) {
    if (!fcmEnabled()) return null;
    const candidates = userId !== undefined ? [userId] : [viewer.id, ...listUsers().map((u) => u.id)];
    for (const id of candidates) {
      const owner = getUser(id);
      if (!owner || !canSee(viewer, id) || (id !== viewer.id && isHidden(owner))) continue;
      if (!linkedDevices(id).some((d) => d.deviceId === deviceId)) continue;
      const token = pushTokenOf(id, deviceId);
      if (token) return token;
    }
    return null;
  }

  // Tells every device of an account that has a push token, never throws.
  function pushToAccount(userId, message) {
    if (!fcmEnabled()) return;
    for (const target of pushTokensOf(userId)) sendNotification(target, message).catch(() => {});
  }

  // Last find push per asker and asked person, and devices that get their pending find
  // requests right after the next device list.
  const findPushes = new Map();
  const replayFinds = new Set();

  // The devices of the asked account that have a token and no open socket.
  function findPushTargets(targetId) {
    if (!fcmEnabled()) return [];
    const online = new Set(onlineDevices(targetId).map((d) => d.id));
    return pushTokensOf(targetId).filter((t) => !online.has(t.deviceId));
  }

  function pushFind(askerId, targetId, targets, session) {
    const key = `${askerId}:${targetId}`;
    const now = Date.now();
    if (now - (findPushes.get(key) ?? 0) < FIND_PUSH_COOLDOWN_MS) return;
    findPushes.set(key, now);
    for (const [k, at] of findPushes) if (now - at >= FIND_PUSH_COOLDOWN_MS) findPushes.delete(k);
    const from = getUser(askerId).display_name;
    for (const target of targets) {
      sendNotification(target, {
        title: "Find request",
        body: `${from} wants to find you`,
        data: { type: "findRequest", session: session.id, from },
      }).catch(() => {});
    }
  }

  // Whoever is still in a find session hears how it ended. While it was pending, every device
  // of the asked account had the question open.
  const finder = createFinder({
    onEnd(session, reason) {
      const ended = { type: "findEnded", session: session.id, reason };
      sendTo(session.asker.userId, session.asker.deviceId, ended);
      if (session.target.deviceId) sendTo(session.target.userId, session.target.deviceId, ended);
      else for (const device of onlineDevices(session.target.userId)) send(device.socket, ended);
    },
  });

  // A device without a socket stays online for two of its report periods (see statusOf).
  // Nothing happens when that time runs out, so this looks now and then and tells everyone.
  let lastStatuses = "";
  const sweep = setInterval(() => {
    // Hiding that ran out shows the person again, so it counts as a change too.
    const statuses = allDevices()
      .map((d) => `${d.userId}:${d.id}:${statusOf(d)}:${isHidden(getUser(d.userId))}`)
      .join("|");
    if (statuses === lastStatuses) return;
    lastStatuses = statuses;
    broadcastDevices();
  }, config.statusSweepMs);
  sweep.unref?.();

  // Everybody gets the devices of the people they share a group with, so the payload differs
  // per account. Sent to every device and dashboard, at most twice a second.
  function broadcastDevices() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const payloads = new Map();
      const payloadFor = (userId) => {
        if (!payloads.has(userId)) {
          const viewer = getUser(userId);
          payloads.set(userId, viewer ? { type: "dataResponse", devices: serializeDevices(viewer) } : null);
        }
        return payloads.get(userId);
      };
      for (const device of onlineDevices()) {
        send(device.socket, payloadFor(device.userId));
        const key = `${device.userId}:${device.id}`;
        if (replayFinds.delete(key)) {
          for (const s of finder.pendingFor(device.userId)) {
            send(device.socket, { type: "findRequest", session: s.id, from: peerOf(s.asker.userId), expiresAt: s.expiresAt });
          }
        }
      }
      for (const [viewer, userId] of viewers) send(viewer, payloadFor(userId));
    }, BROADCAST_THROTTLE_MS);
  }

  // Tells the clients of these accounts to reload their groups and invites.
  function notifyGroups(userIds) {
    const ids = new Set(userIds);
    const message = { type: "groupsChanged" };
    for (const device of onlineDevices()) if (ids.has(device.userId)) send(device.socket, message);
    for (const [viewer, userId] of viewers) if (ids.has(userId)) send(viewer, message);
    broadcastDevices();
  }

  // Tells the devices and dashboards of these accounts that their notifications changed.
  function notifyNotifications(userIds) {
    const ids = new Set(userIds);
    const message = { type: "notificationsChanged" };
    for (const device of onlineDevices()) if (ids.has(device.userId)) send(device.socket, message);
    for (const [viewer, userId] of viewers) if (ids.has(userId)) send(viewer, message);
  }

  // Asks devices for a fresh fix and resolves once they answered or the wait is over.
  // `only` narrows it to one device, `except` leaves the asking device out.
  function requestLocation({ only = null, except = null, viewer = null } = {}) {
    const targets = onlineDevices().filter(
      (d) =>
        (!viewer || canSee(viewer, d.userId)) &&
        // A hidden phone is not woken for anyone else.
        (!viewer || d.userId === viewer.id || !isHidden(getUser(d.userId))) &&
        !(except && d.userId === except.userId && d.id === except.deviceId) &&
        (!only || (d.id === only.deviceId && (only.userId === undefined || d.userId === only.userId)))
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
          send(socket, { type: "requestLocation", from: except?.deviceId });
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

  // Whose timeline a request reads: the signed-in account's, or one shared with it (see
  // canSeeTimeline). `full` is false for anyone but the owner and the admin, they do not get what
  // happened while the owner was invisible.
  function timelineReader(ctx, requested) {
    const { user } = currentUser(ctx);
    if (requested === undefined || requested === user.id) return { ownerId: user.id, full: true };
    if (!canSeeTimeline(user, requested)) throw problem(403, "forbidden", "This timeline is not shared with you");
    if (!getUser(requested)) throw problem(404, "unknown-user", "No such account");
    return { ownerId: requested, full: user.is_admin === 1 };
  }


  // Shared by "edit my profile" and the admin editing someone else.
  const ProfileBody = t.object({
    username: t.string().max(64).optional(),
    displayName: t.string().max(64).optional(),
  });
  function applyProfile(userId, body) {
    try {
      const updated = updateUser(userId, body);
      broadcastDevices();
      return publicUser(updated);
    } catch (error) {
      if (error.code === "taken") throw problem(409, "username-taken", error.message);
      if (error.code === "invalid") throw problem(400, "invalid-account", error.message);
      throw error;
    }
  }

  function linkedDevicesOf(userId) {
    const primary = getUser(userId)?.primary_device_id ?? null;
    return linkedDevices(userId).map((link) => {
      const live = getDevice(userId, link.deviceId);
      return {
        ...link,
        primary: link.deviceId === primary,
        deviceType: live?.deviceType ?? link.deviceType,
        status: statusOf(live),
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

  // What the login screens need before anyone is signed in, and which build runs, so an
  // update can be checked from the dashboard and the app.
  app.get(
    "/api/status",
    {
      response: {
        200: t.object({
          version: t.string(),
          commit: t.string().nullable(),
          builtAt: t.string().nullable(),
          // Whether push notifications are set up, so clients can hide what needs them.
          push: t.boolean(),
          // Whether people can sign up with an invite code.
          invites: t.boolean(),
        }),
      },
    },
    () => ({ version: config.version, commit: config.commit, builtAt: config.builtAt, push: fcmEnabled(), invites: config.invites })
  );

  // Everything that takes a password shares one limit per IP.
  app.register((scope) => {
    scope.register(rateLimit({ max: config.loginRateLimit.max, window: config.loginRateLimit.windowMs }));

    // Guessing codes counts against the same per-IP limit as wrong device tokens.
    const invitesOn = () => {
      if (!config.invites) throw problem(404, "invites-off", "Invite codes are turned off");
    };
    const blockGuessing = (ctx) => {
      if (authFailures.blocked(ctx.ip)) throw problem(429, "too-many-attempts", "Too many attempts");
    };

    // Lets the sign-up page show who invited, never why a code is not valid.
    scope.post(
      "/api/invite-codes/check",
      {
        body: t.object({ code: t.string().max(64) }),
        response: {
          200: t.object({ valid: t.boolean(), invitedBy: t.string().optional(), groupName: t.string().nullable().optional() }),
          404: t.problem(),
          429: t.problem(),
        },
      },
      (ctx) => {
        invitesOn();
        blockGuessing(ctx);
        const summary = inviteSummary(ctx.body.code);
        if (!summary) {
          authFailures.fail(ctx.ip);
          return { valid: false };
        }
        return { valid: true, ...summary };
      }
    );

    // Self-service sign-up. The client logs in with the normal routes afterwards.
    scope.post(
      "/api/register",
      {
        body: t.object({
          code: t.string().max(64),
          username: t.string().max(64),
          password: t.string().max(256),
          displayName: t.string().max(64).optional(),
        }),
        response: { 201: User, 400: t.problem(), 404: t.problem(), 409: t.problem(), 429: t.problem() },
      },
      (ctx) => {
        invitesOn();
        blockGuessing(ctx);
        try {
          const { code, ...account } = ctx.body;
          const result = registerWithCode(code, account);
          console.log(
            chalk.cyan(
              `[i] Account ${chalk.whiteBright(result.user.username)} signed up with an invite code of ${chalk.whiteBright(result.inviter.username)}.`
            )
          );
          notifyNotifications(result.recipients);
          for (const id of result.recipients) {
            pushToAccount(id, {
              title: "New account",
              body: `${result.user.display_name} joined with ${result.inviter.display_name}'s invite code`,
              data: { type: "inviteUsed" },
            });
          }
          if (result.group) notifyGroups(audience(result.group.id));
          return reply(201, publicUser(result.user));
        } catch (error) {
          if (error.code === "invalid-code") {
            authFailures.fail(ctx.ip);
            throw problem(404, "invalid-code", "This invite code is not valid");
          }
          if (error.code === "taken") throw problem(409, "username-taken", error.message);
          if (error.code === "invalid") throw problem(400, "invalid-account", error.message);
          throw error;
        }
      }
    );

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
          deviceType: DeviceType.optional(),
        }),
        response: { 200: t.object({ token: t.string(), user: User }), 401: t.problem(), 429: t.problem() },
      },
      (ctx) => {
        const user = verifyLogin(ctx.body.username, ctx.body.password);
        if (!user) throw problem(401, "invalid-credentials", "Wrong username or password");
        return { token: issueToken(user.id, ctx.body.deviceId, ctx.body.deviceType), user: publicUser(user) };
      }
    );

    // Changing the password asks for the current one, so a stolen session or token is not enough.
    scope.post(
      "/api/me/password",
      {
        body: t.object({ currentPassword: t.string().max(256), newPassword: t.string().max(256) }),
        response: {
          200: t.object({ message: t.string(), token: t.string().optional() }),
          400: t.problem(),
          401: t.problem(),
          429: t.problem(),
        },
      },
      (ctx) => {
        const { user, deviceId } = currentUser(ctx);
        if (!verifyLogin(user.username, ctx.body.currentPassword)) {
          throw problem(401, "invalid-credentials", "The current password is wrong");
        }
        if (ctx.body.newPassword.length < 8) throw problem(400, "weak-password", "The password needs at least 8 characters");
        setPassword(user.id, ctx.body.newPassword);
        console.log(chalk.cyan(`[i] ${chalk.whiteBright(user.username)} changed the password.`));
        // Every other device has to log in again. The one asking keeps working with a fresh token.
        for (const device of onlineDevices(user.id)) {
          if (device.id !== deviceId) device.socket.close(CLOSE_POLICY, "Password changed");
        }
        return { message: "Password changed", ...(deviceId ? { token: issueToken(user.id, deviceId) } : {}) };
      }
    );
  });

  app.get("/logout", (ctx) => {
    ctx.session.destroy();
    return ctx.redirect("/login");
  });

  app.register(
    (api) => {
      api.get("/me", { response: { 200: Me, 401: t.problem() } }, (ctx) => meOf(currentUser(ctx).user));

      // Hiding: gone from everyone else's map for a while (minutes) or until turned off (no minutes).
      // The own devices keep reporting, so the own map and timeline go on.
      api.put(
        "/me/hidden",
        {
          body: t.object({ minutes: t.int().min(1).max(7 * 24 * 60).optional() }),
          response: { 200: Me, 400: t.problem(), 401: t.problem() },
        },
        (ctx) => {
          const { user } = currentUser(ctx);
          const minutes = ctx.body.minutes;
          setHiddenUntil(user.id, minutes ? Date.now() + minutes * 60_000 : HIDDEN_FOREVER);
          broadcastDevices();
          return meOf(getUser(user.id));
        }
      );

      api.delete("/me/hidden", { response: { 200: Me, 401: t.problem() } }, (ctx) => {
        const { user } = currentUser(ctx);
        setHiddenUntil(user.id, null);
        broadcastDevices();
        return meOf(getUser(user.id));
      });

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
          deletePushToken(user.id, ctx.params.deviceId);
          getDevice(user.id, ctx.params.deviceId)?.socket?.close(CLOSE_POLICY, "Device removed");
          removeDevice(user.id, ctx.params.deviceId);
          broadcastDevices();
          return reply(204);
        }
      );

      // The device that stands for an account in the people lists, or null for the automatic choice.
      const PrimaryBody = t.object({ deviceId: t.string().min(1).max(64).nullable() });
      const primaryResponse = { 200: User, 401: t.problem(), 403: t.problem(), 404: t.problem() };
      const applyPrimary = (userId, deviceId) => {
        if (deviceId !== null && !linkedDevices(userId).some((d) => d.deviceId === deviceId)) {
          throw problem(404, "unknown-device", "No such linked device");
        }
        setPrimaryDevice(userId, deviceId);
        broadcastDevices();
        return publicUser(getUser(userId));
      };

      api.put("/me/primary-device", { body: PrimaryBody, response: primaryResponse }, (ctx) =>
        applyPrimary(currentUser(ctx).user.id, ctx.body.deviceId)
      );

      api.put("/users/:id/primary-device", { body: PrimaryBody, response: primaryResponse }, (ctx) => {
        requireAdmin(ctx);
        const id = Number(ctx.params.id);
        if (!getUser(id)) throw problem(404, "unknown-user", "No such account");
        return applyPrimary(id, ctx.body.deviceId);
      });

      // Account management, for the admin (the first account).
      api.get(
        "/users",
        { response: { 200: t.array(User.extend({ devices: t.number() })), 401: t.problem(), 403: t.problem() } },
        (ctx) => {
          requireAdmin(ctx);
          return listUsers().map((u) => ({ ...publicUser(u), devices: linkedDevices(u.id).length }));
        }
      );

      // Suggestions while typing a username to invite. Leaves out yourself and, with a groupId,
      // the people who are in that group or already invited.
      api.get(
        "/users/search",
        {
          query: t.object({ q: t.string().max(64), groupId: t.number().optional() }),
          response: { 200: t.array(User), 401: t.problem() },
        },
        (ctx) => {
          const { user } = currentUser(ctx);
          const exclude = [user.id];
          const group = ctx.query.groupId === undefined ? null : getGroup(ctx.query.groupId);
          if (group && (isMember(group.id, user.id) || user.is_admin === 1)) {
            exclude.push(...audience(group.id));
          }
          return searchUsers(ctx.query.q, { excludeIds: exclude }).map(publicUser);
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
            joinFixedGroups(user.id);
            console.log(chalk.cyan(`[i] Account ${chalk.whiteBright(user.username)} created in the dashboard.`));
            return reply(201, publicUser(user));
          } catch (error) {
            if (error.code === "taken") throw problem(409, "username-taken", error.message);
            if (error.code === "invalid") throw problem(400, "invalid-account", error.message);
            throw error;
          }
        }
      );

      // The admin edits any account: name, username and, to help someone who is locked out, a new password.
      api.patch(
        "/users/:id",
        {
          body: ProfileBody.extend({ password: t.string().max(256).optional() }),
          response: { 200: User, 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem(), 409: t.problem() },
        },
        (ctx) => {
          requireAdmin(ctx);
          const id = Number(ctx.params.id);
          if (!getUser(id)) throw problem(404, "unknown-user", "No such account");
          const { password, ...profile } = ctx.body;
          if (password !== undefined && password.length < 8) throw problem(400, "weak-password", "The password needs at least 8 characters");
          const updated = applyProfile(id, profile);
          if (password !== undefined) {
            setPassword(id, password);
            disconnectAccount(id, "Password changed");
          }
          return updated;
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

      api.patch(
        "/me",
        {
          body: ProfileBody,
          response: { 200: User, 400: t.problem(), 401: t.problem(), 409: t.problem() },
        },
        (ctx) => applyProfile(currentUser(ctx).user.id, ctx.body)
      );


      // Invite codes: anybody signed in can make them, the admin sees all.
      const Person = t.object({ id: t.number(), username: t.string(), displayName: t.string(), avatarUrl: t.string().nullable() });
      const InviteCode = t.object({
        id: t.number(),
        code: t.string(),
        status: t.enum(["open", "used", "expired", "revoked"]),
        note: t.string().nullable(),
        groupId: t.number().nullable(),
        groupName: t.string().nullable(),
        createdAt: t.string(),
        expiresAt: t.string(),
        createdBy: Person,
        usedBy: Person.nullable(),
        usedAt: t.string().nullable(),
      });

      api.post(
        "/invite-codes",
        {
          body: t.object({ groupId: t.int().optional(), note: t.string().max(60).optional() }).optional(),
          response: { 201: InviteCode, 400: t.problem(), 401: t.problem(), 404: t.problem(), 429: t.problem() },
        },
        (ctx) => {
          const { user } = currentUser(ctx);
          if (!config.invites) throw problem(404, "invites-off", "Invite codes are turned off");
          try {
            return reply(201, inviteView(getInviteCode(createInvite(user, ctx.body ?? {}))));
          } catch (error) {
            if (error.code === "limit") throw problem(429, "too-many-codes", error.message);
            if (error.code === "unknown-group") throw problem(404, "unknown-group", error.message);
            if (error.code === "invalid") throw problem(400, "invalid-invite", error.message);
            throw error;
          }
        }
      );

      api.get("/invite-codes", { response: { 200: t.array(InviteCode), 401: t.problem() } }, (ctx) =>
        listInvites(currentUser(ctx).user)
      );

      api.delete(
        "/invite-codes/:id",
        { response: { 204: t.empty(), 401: t.problem(), 404: t.problem() } },
        (ctx) => {
          const { user } = currentUser(ctx);
          if (!revokeInvite(user, Number(ctx.params.id))) throw problem(404, "unknown-invite-code", "No such open invite code");
          return reply(204);
        }
      );

      const Notification = t.object({
        id: t.number(),
        type: t.literal("inviteUsed"),
        createdAt: t.string(),
        readAt: t.string().nullable(),
        data: t.object({
          user: Person,
          invitedBy: t.object({ id: t.number(), username: t.string(), displayName: t.string() }),
          groupName: t.string().nullable(),
        }),
      });

      api.get("/notifications", { response: { 200: t.array(Notification), 401: t.problem() } }, (ctx) =>
        notificationsFor(currentUser(ctx).user.id)
      );

      api.post(
        "/notifications/read",
        {
          body: t.object({ ids: t.array(t.int()).max(200).optional() }).optional(),
          response: { 204: t.empty(), 401: t.problem() },
        },
        (ctx) => {
          const { user } = currentUser(ctx);
          markRead(user.id, ctx.body?.ids);
          notifyNotifications([user.id]);
          return reply(204);
        }
      );

      // Groups decide who sees whom.
      const Member = User.extend({ role: t.enum(["owner", "member"]) });
      const Group = t.object({
        id: t.number(),
        name: t.string(),
        ownerId: t.number(),
        role: t.enum(["owner", "member"]),
        canManage: t.boolean(),
        // Everybody is in it for good: no leaving, no removing, no deleting.
        fixed: t.boolean(),
        members: t.array(Member),
        pendingInvites: t.array(t.object({ id: t.number(), user: User })),
      });
      const Invite = t.object({
        id: t.number(),
        groupId: t.number(),
        groupName: t.string(),
        invitedBy: t.object({ id: t.number(), username: t.string(), displayName: t.string() }).nullable(),
        createdAt: t.string(),
      });
      const GroupName = t.object({ name: t.string().max(64) });

      function groupFor(ctx, { manage = false } = {}) {
        const { user } = currentUser(ctx);
        const group = getGroup(Number(ctx.params.id));
        if (!group || (!isMember(group.id, user.id) && user.is_admin !== 1)) throw problem(404, "unknown-group", "No such group");
        if (manage && !canManage(group, user)) throw problem(403, "forbidden", "Only the owner can do this");
        return { user, group };
      }

      const viewOf = (user, groupId) => groupsFor(user).find((g) => g.id === groupId);

      api.get("/groups", { response: { 200: t.array(Group), 401: t.problem() } }, (ctx) => groupsFor(currentUser(ctx).user));

      api.post(
        "/groups",
        { body: GroupName, response: { 201: Group, 400: t.problem(), 401: t.problem() } },
        (ctx) => {
          const { user } = currentUser(ctx);
          try {
            const group = createGroup(user.id, ctx.body.name);
            notifyGroups([user.id]);
            return reply(201, viewOf(user, group.id));
          } catch (error) {
            if (error.code === "invalid") throw problem(400, "invalid-group", error.message);
            throw error;
          }
        }
      );

      api.patch(
        "/groups/:id",
        { body: GroupName, response: { 200: Group, 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem() } },
        (ctx) => {
          const { user, group } = groupFor(ctx, { manage: true });
          try {
            renameGroup(group.id, ctx.body.name);
          } catch (error) {
            if (error.code === "invalid") throw problem(400, "invalid-group", error.message);
            throw error;
          }
          notifyGroups(audience(group.id));
          return viewOf(user, group.id) ?? viewOf(getUser(group.owner_id), group.id);
        }
      );

      api.delete(
        "/groups/:id",
        { response: { 204: t.empty(), 401: t.problem(), 403: t.problem(), 404: t.problem() } },
        (ctx) => {
          const { group } = groupFor(ctx, { manage: true });
          if (isFixed(group)) throw problem(403, "fixed-group", `${group.name} holds everyone and cannot be deleted`);
          const people = deleteGroup(group.id);
          notifyGroups(people);
          return reply(204);
        }
      );

      // Invite an existing account by username. The invited person accepts or declines.
      api.post(
        "/groups/:id/invites",
        {
          body: t.object({ username: t.string().max(64) }),
          response: { 201: Message, 401: t.problem(), 403: t.problem(), 404: t.problem(), 409: t.problem() },
        },
        (ctx) => {
          const { user, group } = groupFor(ctx, { manage: true });
          try {
            const target = invite(group.id, user.id, ctx.body.username);
            notifyGroups([user.id, group.owner_id, target.id]);
            pushToAccount(target.id, {
              title: "Group invitation",
              body: `${user.display_name} invited you to ${group.name}`,
              data: { type: "groupInvite", groupId: group.id },
            });
            return reply(201, { message: target.display_name + " was invited" });
          } catch (error) {
            if (error.code === "notfound") throw problem(404, "unknown-user", error.message);
            if (error.code === "member" || error.code === "invited") throw problem(409, "already-there", error.message);
            throw error;
          }
        }
      );

      api.delete(
        "/groups/:id/invites/:inviteId",
        { response: { 204: t.empty(), 401: t.problem(), 403: t.problem(), 404: t.problem() } },
        (ctx) => {
          const { group } = groupFor(ctx, { manage: true });
          const row = getInvite(Number(ctx.params.inviteId));
          if (!row || row.group_id !== group.id) throw problem(404, "unknown-invite", "No such invite");
          cancelInvite(row.id);
          notifyGroups([group.owner_id, row.user_id]);
          return reply(204);
        }
      );

      // Remove a member (the owner) or leave (yourself). The owner cannot leave, delete the group instead.
      api.delete(
        "/groups/:id/members/:userId",
        { response: { 204: t.empty(), 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem() } },
        (ctx) => {
          const { user, group } = groupFor(ctx);
          const target = Number(ctx.params.userId);
          if (!isMember(group.id, target)) throw problem(404, "unknown-member", "Not in this group");
          if (isFixed(group)) throw problem(403, "fixed-group", `Everybody stays in ${group.name}`);
          if (target === group.owner_id) throw problem(400, "owner", "The owner stays in the group, delete the group instead");
          if (target !== user.id && !canManage(group, user)) throw problem(403, "forbidden", "Only the owner can remove people");
          const people = audience(group.id);
          removeMember(group.id, target);
          notifyGroups(people);
          return reply(204);
        }
      );

      api.get("/invites", { response: { 200: t.array(Invite), 401: t.problem() } }, (ctx) => invitesFor(currentUser(ctx).user.id));

      for (const action of ["accept", "decline"]) {
        api.post(
          "/invites/:id/" + action,
          { response: { 204: t.empty(), 401: t.problem(), 404: t.problem() } },
          (ctx) => {
            const { user } = currentUser(ctx);
            const row = getInvite(Number(ctx.params.id));
            if (!row || row.user_id !== user.id) throw problem(404, "unknown-invite", "No such invite");
            const owner = getGroup(row.group_id)?.owner_id;
            const people = audience(row.group_id);
            if (action === "accept") acceptInvite(row.id);
            else cancelInvite(row.id);
            notifyGroups([...people, owner].filter(Boolean));
            return reply(204);
          }
        );
      }

      api.post(
        "/auth/logout",
        { response: { 200: Message, 401: t.problem() } },
        (ctx) => {
          const { token } = deviceAuth(ctx);
          revokeToken(token);
          return { message: "Logged out" };
        }
      );

      // The FCM registration token of the app, so the server can wake the phone and notify it.
      api.put(
        "/push-token",
        {
          body: t.object({ token: t.string().min(1).max(4096), platform: t.enum(PUSH_PLATFORMS) }),
          response: { 204: t.empty(), 401: t.problem(), 429: t.problem() },
        },
        (ctx) => {
          const { user, deviceId } = deviceAuth(ctx);
          setPushToken(user.id, deviceId, ctx.body.token, ctx.body.platform);
          return reply(204);
        }
      );

      api.delete("/push-token", { response: { 204: t.empty(), 401: t.problem(), 429: t.problem() } }, (ctx) => {
        const { user, deviceId } = deviceAuth(ctx);
        deletePushToken(user.id, deviceId);
        return reply(204);
      });

      api.get("/getData", { response: { 200: t.array(Device), 401: t.problem() } }, (ctx) =>
        serializeDevices(currentUser(ctx).user)
      );

      api.post(
        "/sendPing",
        {
          body: t.object({ deviceId: t.string().max(64).optional(), userId: t.number().optional() }).optional(),
          response: {
            200: t.object({ message: t.string(), devices: t.array(Device) }),
            202: Message,
            401: t.problem(),
            404: t.problem(),
            502: t.problem(),
          },
        },
        async (ctx) => {
          const { user } = currentUser(ctx);
          const { deviceId, userId } = ctx.body ?? {};
          const reachable = onlineDevices().filter((d) => canSee(user, d.userId));
          const only = deviceId ? { deviceId, userId } : null;
          const connected = only && reachable.some((d) => d.id === deviceId && (userId === undefined || d.userId === userId));
          // No socket: wake the phone with a push and wait for its background task to report.
          const wake = only && !connected ? wakeTarget(user, deviceId, userId) : null;
          if (wake) {
            const answer = waitForPosition(wake.userId, deviceId, config.pushWaitMs);
            const outcome = await sendWakeUp(wake, { from: user.display_name });
            if (outcome === "failed") {
              answer.cancel();
              throw problem(502, "push-failed", `Device ${deviceId} could not be woken, the push service refused the request`);
            }
            if (await answer.done) {
              broadcastDevices();
              return { message: `Location request sent to ${deviceId}`, devices: serializeDevices(user) };
            }
            return reply(202, { message: "Location requested, the device has not answered yet" });
          }
          if (reachable.length === 0) return reply(202, { message: "No devices connected" });
          if (only && !reachable.some((d) => d.id === deviceId && (userId === undefined || d.userId === userId))) {
            throw problem(404, "device-not-connected", `Device ${deviceId} is not connected`);
          }
          const asked = await requestLocation({ only, viewer: user });
          broadcastDevices();
          return {
            message: deviceId ? `Location request sent to ${deviceId}` : `Location request sent to ${asked} devices`,
            devices: serializeDevices(user),
          };
        }
      );

      // Whose data: the signed-in account, or for the admin any account (see targetUserId).
      const ForUser = t.object({ userId: t.number().optional() });

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
        async (ctx) => {
          const { ownerId: userId, full } = timelineReader(ctx, ctx.query.userId);
          const range = dayRange(ctx.query.date, ctx.query.tz ?? 0);
          if (!range) throw problem(400, "bad-date", "date has to look like 2025-01-31");
          // The fixes and dismissed stops from while the owner was invisible are not for others.
          const spans = full ? [] : hiddenSpans(userId, range.from, range.to);
          const points = withoutSpans(positionsBetween(userId, ctx.query.deviceId, range.from, range.to), spans);
          const dismissed = withoutSpans(dismissedVisits(userId, ctx.query.deviceId, range.from, range.to), spans);
          const timeline = buildTimeline(points, { dismissed });
          // The paths need the final mode of every trip, corrections included, so they come after the lines.
          const [places, paths] = await Promise.all([
            namePlaces(userId, timeline.segments, { tzOffsetMin: ctx.query.tz ?? 0 }),
            matchTransit(userId, ctx.query.deviceId, timeline.segments).then(() =>
              smoothPaths(userId, ctx.query.deviceId, timeline.segments)
            ),
          ]);
          return {
            date: ctx.query.date,
            deviceId: ctx.query.deviceId,
            ...timeline,
            placesPending: places.pending,
            pathsPending: paths.pending,
            dismissed,
          };
        }
      );

      // "That was no stop": a red light or a jam the timeline took for a stay. `dismissed: false`
      // brings it back. The stop is named by its device, start and end, as the timeline sent it.
      api.put(
        "/visits/dismissed",
        {
          query: ForUser,
          body: t.object({
            deviceId: t.string().min(1).max(64),
            start: t.int().min(0),
            end: t.int().min(0),
            dismissed: t.boolean(),
          }),
          response: { 204: t.empty(), 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem() },
        },
        (ctx) => {
          const { deviceId, start, end, dismissed } = ctx.body;
          if (end < start || end - start > 86_400_000) throw problem(400, "bad-span", "end has to follow start, within a day");
          const userId = targetUserId(ctx, ctx.query.userId);
          const done = dismissed ? dismissVisit(userId, deviceId, start, end) : restoreVisit(userId, deviceId, start);
          if (!done) throw problem(404, "unknown-visit", dismissed ? "No stop of that device starts there" : "No dismissed stop starts there");
          return reply(204);
        }
      );

      // "That was by car": the person's word on how a trip was made beats what the server made
      // of it. `auto` goes back to the server's guess. The trip is named by its device and start.
      api.put(
        "/trips/mode",
        {
          query: ForUser,
          body: t.object({ deviceId: t.string().min(1).max(64), start: t.int().min(0), mode: t.enum([...TRIP_MODES, "auto"]) }),
          response: { 204: t.empty(), 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem() },
        },
        (ctx) => {
          const { deviceId, start, mode } = ctx.body;
          if (!setTripMode(targetUserId(ctx, ctx.query.userId), deviceId, start, mode)) {
            throw problem(404, "unknown-trip", "No trip of that device starts there");
          }
          return reply(204);
        }
      );

      // Which days have anything to show.
      api.get(
        "/timeline/days",
        {
          query: t.object({ deviceId: t.string().max(64), tz: t.number().optional(), userId: t.number().optional() }),
          response: { 200: t.array(t.string()), 401: t.problem(), 403: t.problem(), 404: t.problem() },
        },
        (ctx) => {
          const { ownerId, full } = timelineReader(ctx, ctx.query.userId);
          return daysWithData(ownerId, ctx.query.deviceId, ctx.query.tz ?? 0, { exceptHidden: !full });
        }
      );

      // Who may read my timeline: nobody ("off"), everyone in my groups, or chosen people and groups.
      const TimelineSharing = t.object({
        mode: t.enum(SHARING_MODES),
        users: t.array(t.int()).max(200),
        groups: t.array(t.int()).max(200),
      });

      api.get("/timeline/sharing", { response: { 200: TimelineSharing, 401: t.problem() } }, (ctx) =>
        timelineSharing(currentUser(ctx).user.id)
      );

      api.put(
        "/timeline/sharing",
        { body: TimelineSharing, response: { 200: TimelineSharing, 400: t.problem(), 401: t.problem() } },
        (ctx) => {
          const { user } = currentUser(ctx);
          try {
            return saveTimelineSharing(user.id, ctx.body);
          } catch (error) {
            if (error.code === "invalid") throw problem(400, "invalid-sharing", error.message);
            throw error;
          }
        }
      );

      // Whose timelines I may read, myself first, with the devices to pick from.
      api.get(
        "/timeline/people",
        {
          response: {
            200: t.array(
              t.object({ userId: t.number(), displayName: t.string(), avatarUrl: t.string().nullable(), devices: t.array(t.string()) })
            ),
            401: t.problem(),
          },
        },
        (ctx) => timelinePeople(currentUser(ctx).user)
      );

      // Which regions have timetable data for the lines in the timeline, and how fresh it is.
      const TransitFeed = t.object({
        name: t.string(),
        provider: t.string().nullable(),
        license: t.string().nullable(),
        stops: t.number(),
        routes: t.number(),
        trips: t.number(),
        updatedAt: t.string().nullable(),
      });
      const TransitStatus = t.object({
        enabled: t.boolean(),
        regions: t.array(t.object({ cell: t.string(), feeds: t.array(TransitFeed), updatedAt: t.string().nullable() })),
      });

      api.get("/transit", { response: { 200: TransitStatus, 401: t.problem() } }, (ctx) => {
        currentUser(ctx);
        return transitStatus();
      });

      // Own places: home, work, and every place someone confirmed for a visit. They win
      // over OpenStreetMap the next time someone stays there. The admin may label the
      // places of any account, the way it opens their timeline.
      api.get(
        "/places",
        { query: ForUser, response: { 200: t.array(Place), 401: t.problem(), 403: t.problem(), 404: t.problem() } },
        (ctx) => listPlaces(targetUserId(ctx, ctx.query.userId))
      );

      // What a visit could have been: own places close by, then OpenStreetMap, nearest first.
      api.get(
        "/places/nearby",
        {
          query: ForUser.extend({ lat: t.number().min(-90).max(90), lon: t.number().min(-180).max(180) }),
          response: {
            200: t.array(VisitPlace.extend({ distanceM: t.number() })),
            401: t.problem(),
            403: t.problem(),
            404: t.problem(),
          },
        },
        (ctx) => placeChoices(targetUserId(ctx, ctx.query.userId), ctx.query.lat, ctx.query.lon)
      );

      // "I was here": names the spot. An own place that already covers it is corrected.
      // Tagged as home or work it needs no name and becomes "Home", "Home 2", ...
      api.post(
        "/places",
        {
          query: ForUser,
          body: t.object({
            lat: t.number().min(-90).max(90),
            lon: t.number().min(-180).max(180),
            name: PlaceName.optional(),
            kind: t.enum(PLACE_KINDS).optional(),
            radiusM: PlaceRadius.optional(),
            osmId: t.string().max(40).optional(),
          }),
          response: { 200: Place, 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem() },
        },
        (ctx) => {
          const { name, kind } = ctx.body;
          if (name === undefined && !TAG_KINDS.includes(kind)) {
            throw problem(400, "name-required", "Give the place a name, or tag it as Home or Work");
          }
          return savePlaceAt(targetUserId(ctx, ctx.query.userId), { ...ctx.body, name: name?.trim() });
        }
      );

      // Picking an own place for a visit: the spot belongs to it from now on.
      api.post(
        "/places/:id/claim",
        {
          query: ForUser,
          body: t.object({ lat: t.number().min(-90).max(90), lon: t.number().min(-180).max(180) }),
          response: { 200: Place, 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem() },
        },
        (ctx) => {
          const place = claimSpot(targetUserId(ctx, ctx.query.userId), Number(ctx.params.id), ctx.body.lat, ctx.body.lon);
          if (!place) throw problem(404, "unknown-place", "No such place");
          return place;
        }
      );

      api.patch(
        "/places/:id",
        {
          query: ForUser,
          body: t.object({ name: PlaceName.optional(), kind: t.enum(PLACE_KINDS).optional(), radiusM: PlaceRadius.optional() }),
          response: { 200: Place, 400: t.problem(), 401: t.problem(), 403: t.problem(), 404: t.problem() },
        },
        (ctx) => {
          const { name, ...rest } = ctx.body;
          const place = updatePlace(targetUserId(ctx, ctx.query.userId), Number(ctx.params.id), {
            ...rest,
            name: name?.trim(),
          });
          if (!place) throw problem(404, "unknown-place", "No such place");
          return place;
        }
      );

      api.delete(
        "/places/:id",
        { query: ForUser, response: { 204: t.empty(), 401: t.problem(), 403: t.problem(), 404: t.problem() } },
        (ctx) => {
          if (!deletePlace(targetUserId(ctx, ctx.query.userId), Number(ctx.params.id))) {
            throw problem(404, "unknown-place", "No such place");
          }
          return reply(204);
        }
      );
    },
    {},
    { prefix: "/api" }
  );

  // Profile pictures belong to the account. Set from the app or the dashboard, everyone signed in can see them.
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
        broadcastDevices();
        return { avatarUrl: publicUser(updated).avatarUrl };
      }
    );

    avatars.delete(
      "/api/avatar",
      { response: { 204: t.empty(), 401: t.problem(), 429: t.problem() } },
      (ctx) => {
        const { user } = currentUser(ctx);
        clearAvatar(user.id);
        broadcastDevices();
        return reply(204);
      }
    );

    avatars.get("/avatars/:userId", (ctx) => {
      const { user } = currentUser(ctx);
      const wanted = Number(ctx.params.userId);
      const avatar = canSee(user, wanted) ? avatarFor(wanted) : null;
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
          send(socket, { type: "dataResponse", devices: serializeDevices(getUser(id)) });
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
        const replaced = attachSocket(account, deviceId, socket, msg.deviceType, msg.interval);
        const label = `${chalk.whiteBright(user.username)}/${chalk.whiteBright(deviceId)}`;
        if (replaced) {
          console.log(chalk.yellow(`[i] Device ${label} reconnected. Replacing the previous connection.`));
          replaced.replaced = true;
          replaced.close(CLOSE_REPLACED, "Replaced by a newer connection");
        } else {
          console.log(chalk.greenBright(`[+] Device ${label} connected.`));
        }
        // What this server understands beyond the basics, so newer apps know what they may send.
        send(socket, { successful: true, features: ["positionBatch", "find"] });
        if (finder.pendingFor(account).length > 0) replayFinds.add(`${account}:${deviceId}`);
        broadcastDevices();
      };

      const handle = async (msg) => {
        switch (msg.type) {
          case "ping":
            send(socket, { type: "pong" });
            break;
          case "getData":
            send(socket, { type: "dataResponse", devices: serializeDevices(getUser(account)) });
            break;
          case "pingDevices":
            await requestLocation({ except: { userId: account, deviceId }, viewer: getUser(account) });
            send(socket, { type: "dataResponse", devices: serializeDevices(getUser(account)) });
            break;
          case "updatePosition":
            if (role !== "device") return;
            updatePosition(account, deviceId, msg.latitude, msg.longitude);
            reported(account, deviceId);
            if (msg.battery) updateBattery(account, deviceId, msg.battery.level, msg.battery.charging);
            recordPosition(account, deviceId, msg.latitude, msg.longitude, fixTime(msg.recordedAt), fixExtras(msg));
            broadcastDevices();
            break;
          case "positionBatch": {
            if (role !== "device") return;
            // Only the history: these fixes are older than what the map already shows.
            const points = [...msg.points].sort((a, b) => fixTime(a.recordedAt) - fixTime(b.recordedAt));
            for (const p of points) recordPosition(account, deviceId, p.latitude, p.longitude, fixTime(p.recordedAt), fixExtras(p));
            break;
          }
          case "updateBattery":
            if (role !== "device") return;
            updateBattery(account, deviceId, msg.level, msg.charging);
            broadcastDevices();
            break;
          case "locationError":
            console.log(chalk.yellow(`[!] ${chalk.whiteBright(deviceId)} could not read its location: ${msg.message}`));
            break;
          case "findRequest": {
            if (role !== "device") return;
            const me = getUser(account);
            const target = getUser(msg.userId);
            const fail = (reason) => send(socket, { type: "findEnded", session: null, reason });
            // Only people who see each other on the map, and nobody who hides right now.
            if (!target || target.id === account || !canSee(me, target.id) || isHidden(target)) return fail("unavailable");
            const phones = onlineDevices(target.id);
            const pushTargets = findPushTargets(target.id);
            if (phones.length === 0 && pushTargets.length === 0) return fail("offline");
            const session = finder.request({ askerUserId: account, askerDeviceId: deviceId, targetUserId: target.id });
            if (pushTargets.length > 0) pushFind(account, target.id, pushTargets, session);
            const ask = { type: "findRequest", session: session.id, from: peerOf(account), expiresAt: session.expiresAt };
            for (const phone of phones) send(phone.socket, ask);
            send(socket, { type: "findPending", session: session.id, peer: peerOf(target.id), expiresAt: session.expiresAt });
            break;
          }
          case "findAnswer": {
            if (role !== "device") return;
            const session = finder.answer(msg.session, { userId: account, deviceId, accept: msg.accept });
            if (!session || session.status !== "active") return;
            // The other devices of the account drop the question.
            for (const phone of onlineDevices(account)) {
              if (phone.id !== deviceId) send(phone.socket, { type: "findEnded", session: session.id, reason: "answered" });
            }
            const started = (peerId) => ({ type: "findStarted", session: session.id, peer: peerOf(peerId), expiresAt: session.expiresAt });
            sendTo(session.asker.userId, session.asker.deviceId, started(account));
            send(socket, started(session.asker.userId));
            break;
          }
          case "findPosition": {
            if (role !== "device") return;
            const session = finder.get(msg.session);
            const peer = session && finder.peerOf(session, account, deviceId);
            if (!peer) return;
            sendTo(peer.userId, peer.deviceId, {
              type: "findPosition",
              session: session.id,
              latitude: msg.latitude,
              longitude: msg.longitude,
              accuracy: msg.accuracy ?? null,
              heading: msg.heading ?? null,
              at: Date.now(),
            });
            break;
          }
          case "findEnd": {
            if (role !== "device") return;
            const session = finder.get(msg.session);
            if (session && finder.roleOf(session, account, deviceId)) finder.end(session.id, msg.reason ?? "ended");
            break;
          }
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
          finder.endAllOf(account, deviceId);
          replayFinds.delete(`${account}:${deviceId}`);
          broadcastDevices();
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
    notifyGroups,
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
      clearInterval(sweep);
      broadcastTimer = null;
    },
  };
}

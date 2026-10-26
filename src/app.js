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
  unlinkDevice,
  updateUser,
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
  isMember,
  removeMember,
  renameGroup,
} from "./groups.js";
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

const DeviceType = t.enum(["phone", "tablet", "desktop"]);

const Device = t.object({
  deviceId: t.string(),
  userId: t.number(),
  groupIds: t.array(t.number()),
  owner: t.object({ username: t.string(), displayName: t.string() }),
  position: Position.nullable(),
  lastPing: t.string().nullable(),
  status: t.enum(["online", "offline"]),
  avatarUrl: t.string().nullable(),
  deviceType: DeviceType,
});

const User = t.object({
  id: t.number(),
  username: t.string(),
  displayName: t.string(),
  isAdmin: t.boolean(),
  mustChangePassword: t.boolean(),
  avatarUrl: t.string().nullable(),
});

const LinkedDevice = t.object({
  deviceId: t.string(),
  linkedAt: t.string(),
  deviceType: DeviceType,
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
    deviceType: DeviceType.optional(),
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
      for (const device of onlineDevices()) send(device.socket, payloadFor(device.userId));
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

  // Asks devices for a fresh fix and resolves once they answered or the wait is over.
  // `only` narrows it to one device, `except` leaves the asking device out.
  function requestLocation({ only = null, except = null, viewer = null } = {}) {
    const targets = onlineDevices().filter(
      (d) =>
        (!viewer || canSee(viewer, d.userId)) &&
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
    return linkedDevices(userId).map((link) => {
      const live = getDevice(userId, link.deviceId);
      return {
        ...link,
        deviceType: live?.deviceType ?? link.deviceType,
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
    { response: { 200: t.object({ version: t.string() }) } },
    () => ({ version: config.version })
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
          broadcastDevices();
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


      // Groups decide who sees whom.
      const Member = User.extend({ role: t.enum(["owner", "member"]) });
      const Group = t.object({
        id: t.number(),
        name: t.string(),
        ownerId: t.number(),
        role: t.enum(["owner", "member"]),
        canManage: t.boolean(),
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
          },
        },
        async (ctx) => {
          const { user } = currentUser(ctx);
          const { deviceId, userId } = ctx.body ?? {};
          const reachable = onlineDevices().filter((d) => canSee(user, d.userId));
          if (reachable.length === 0) return reply(202, { message: "No devices connected" });
          const only = deviceId ? { deviceId, userId } : null;
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
        const replaced = attachSocket(account, deviceId, socket, msg.deviceType);
        const label = `${chalk.whiteBright(user.username)}/${chalk.whiteBright(deviceId)}`;
        if (replaced) {
          console.log(chalk.yellow(`[i] Device ${label} reconnected. Replacing the previous connection.`));
          replaced.replaced = true;
          replaced.close(CLOSE_REPLACED, "Replaced by a newer connection");
        } else {
          console.log(chalk.greenBright(`[+] Device ${label} connected.`));
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
            send(socket, { type: "dataResponse", devices: serializeDevices(getUser(account)) });
            break;
          case "pingDevices":
            await requestLocation({ except: { userId: account, deviceId }, viewer: getUser(account) });
            send(socket, { type: "dataResponse", devices: serializeDevices(getUser(account)) });
            break;
          case "updatePosition":
            if (role !== "device") return;
            updatePosition(account, deviceId, msg.latitude, msg.longitude);
            recordPosition(account, deviceId, msg.latitude, msg.longitude);
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
        if (role === "device" && !socket.replaced && detachSocket(account, deviceId, socket)) {
          console.log(chalk.redBright(`[-] Device ${chalk.whiteBright(deviceId)} disconnected. Marked offline.`));
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
      broadcastTimer = null;
    },
  };
}

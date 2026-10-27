import crypto from "crypto";

// "Find me": a short session between two phones. Once the asked person accepts, both send
// their position every second, to each other only, until they met or the time is up.
// Nothing of it goes into the history. Sessions live in memory.
export const PENDING_MS = 2 * 60_000;
export const ACTIVE_MS = 30 * 60_000;

const sameDevice = (a, userId, deviceId) => a.userId === userId && a.deviceId === deviceId;

// onEnd(session, reason) is told whenever a session is over, by whichever side or the clock.
export function createFinder({ onEnd = () => {}, now = Date.now } = {}) {
  const sessions = new Map();

  function end(session, reason) {
    if (!sessions.delete(session.id)) return;
    clearTimeout(session.timer);
    session.status = "ended";
    session.reason = reason;
    onEnd(session, reason);
  }

  function expireIn(session, ms) {
    clearTimeout(session.timer);
    session.expiresAt = now() + ms;
    session.timer = setTimeout(() => end(session, "timeout"), ms);
    session.timer.unref?.();
  }

  return {
    // The asking device may run one search at a time, a new one replaces the old.
    request({ askerUserId, askerDeviceId, targetUserId }) {
      for (const s of [...sessions.values()]) if (sameDevice(s.asker, askerUserId, askerDeviceId)) end(s, "replaced");
      const session = {
        id: crypto.randomBytes(9).toString("base64url"),
        status: "pending",
        asker: { userId: askerUserId, deviceId: askerDeviceId },
        target: { userId: targetUserId, deviceId: null },
        createdAt: now(),
        expiresAt: 0,
        timer: null,
      };
      sessions.set(session.id, session);
      expireIn(session, PENDING_MS);
      return session;
    },

    get(id) {
      return sessions.get(id) ?? null;
    },

    // "asker", "target" or null. A pending session belongs to every device of the asked account.
    roleOf(session, userId, deviceId) {
      if (sameDevice(session.asker, userId, deviceId)) return "asker";
      if (session.target.userId !== userId) return null;
      if (session.status === "pending" || session.target.deviceId === deviceId) return "target";
      return null;
    },

    // The first device of the asked account to answer decides. Returns the session, or null
    // when it is not theirs to answer.
    answer(id, { userId, deviceId, accept }) {
      const session = sessions.get(id);
      if (!session || session.status !== "pending" || session.target.userId !== userId) return null;
      if (!accept) {
        end(session, "declined");
        return session;
      }
      session.status = "active";
      session.target.deviceId = deviceId;
      expireIn(session, ACTIVE_MS);
      return session;
    },

    // The other side of an active session, to send a position to.
    peerOf(session, userId, deviceId) {
      if (session.status !== "active") return null;
      if (sameDevice(session.asker, userId, deviceId)) return session.target;
      if (sameDevice(session.target, userId, deviceId)) return session.asker;
      return null;
    },

    end(id, reason = "ended") {
      const session = sessions.get(id);
      if (session) end(session, reason);
      return session ?? null;
    },

    // A device that is gone takes its searches with it.
    endAllOf(userId, deviceId, reason = "disconnected") {
      for (const s of [...sessions.values()]) {
        if (sameDevice(s.asker, userId, deviceId) || (s.status === "active" && sameDevice(s.target, userId, deviceId))) end(s, reason);
      }
    },

    reset() {
      for (const s of [...sessions.values()]) {
        clearTimeout(s.timer);
        sessions.delete(s.id);
      }
    },
  };
}

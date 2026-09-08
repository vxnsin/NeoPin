import crypto from "crypto";
import { config } from "./config.js";

export const SESSION_COOKIE = "neopin_session";

const sessions = new Map();

export function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + config.sessionTtlMs);
  return token;
}

export function isValidSession(token) {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token) {
  sessions.delete(token);
}

export function destroyAllSessions() {
  sessions.clear();
}

export function sessionFromCookieHeader(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: Boolean(req.secure),
    maxAge: config.sessionTtlMs,
  };
}

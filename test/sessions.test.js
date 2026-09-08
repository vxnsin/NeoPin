import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  SESSION_COOKIE,
  createSession,
  destroyAllSessions,
  destroySession,
  isValidSession,
  sessionFromCookieHeader,
} from "../src/sessions.js";

beforeEach(() => destroyAllSessions());

test("a created session is valid until destroyed", () => {
  const token = createSession();
  assert.equal(token.length, 64);
  assert.equal(isValidSession(token), true);
  destroySession(token);
  assert.equal(isValidSession(token), false);
});

test("unknown or empty tokens are rejected", () => {
  assert.equal(isValidSession(undefined), false);
  assert.equal(isValidSession("nope"), false);
});

test("expired sessions are rejected", () => {
  const original = config.sessionTtlMs;
  config.sessionTtlMs = -1;
  const token = createSession();
  config.sessionTtlMs = original;
  assert.equal(isValidSession(token), false);
});

test("the session token is read from the cookie header", () => {
  assert.equal(sessionFromCookieHeader(`theme=dark; ${SESSION_COOKIE}=abc123; other=1`), "abc123");
  assert.equal(sessionFromCookieHeader("theme=dark"), null);
  assert.equal(sessionFromCookieHeader(undefined), null);
});

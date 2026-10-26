import { memoryStore } from "@vxnsin/inkan";
import { session } from "@inkanjs/session";
import { config } from "./config.js";

export const SESSION_COOKIE = "neopin_session";

// Bumped to log out every dashboard at once (password change, sessions-clear).
// A session only counts while it carries the current generation.
let generation = 0;

export function sessionPlugin() {
  return session({
    secret: config.sessionSecret,
    store: memoryStore({ max: 10_000 }),
    cookie: {
      name: SESSION_COOKIE,
      sameSite: "strict",
      secure: config.secureCookies,
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    },
  });
}

export function signIn(session) {
  session.regenerate().set("generation", generation);
}

export function isSignedIn(session) {
  return session?.get("generation") === generation;
}

export function destroyAllSessions() {
  generation += 1;
}

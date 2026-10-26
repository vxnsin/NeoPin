import { memoryStore } from "@vxnsin/inkan";
import { session } from "@inkanjs/session";
import { config } from "./config.js";

export const SESSION_COOKIE = "neopin_session";

// Bumped to log out every dashboard at once (sessions-clear). A session only
// counts while it carries the current generation.
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

export function signIn(session, userId) {
  session.regenerate().set("generation", generation).set("userId", userId);
}

// The id of the signed-in user, or null.
export function sessionUserId(session) {
  if (session?.get("generation") !== generation) return null;
  return session.get("userId") ?? null;
}

export function destroyAllSessions() {
  generation += 1;
}

// Fixed-window counter keyed by client IP. HTTP routes use inkan's rateLimit;
// this one counts failed WebSocket logins, which are no HTTP requests of their own.
export function createAttemptLimiter({ windowMs, max }) {
  const hits = new Map();

  const entryFor = (key) => {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    return entry;
  };

  return {
    blocked: (key) => entryFor(key).count >= max,
    fail: (key) => {
      entryFor(key).count += 1;
    },
    reset: () => hits.clear(),
  };
}

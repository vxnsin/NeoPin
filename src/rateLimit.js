// Minimal fixed-window rate limiter keyed by client IP.
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  const middleware = (req, res, next) => {
    const now = Date.now();
    const key = req.ip || "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ message: "Too many attempts. Try again later." });
    }
    next();
  };

  middleware.reset = () => hits.clear();
  return middleware;
}

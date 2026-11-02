import type { DiagEvent } from "./diagnostics";

const HOUR_MS = 3_600_000;
// Below this a rate per hour says more about rounding than about the phone.
const MIN_SPAN_MS = 10 * 60_000;

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

// Percent per hour while unplugged: the drop between two readings counts when the phone was
// unplugged at both, time on the charger is left out. Null with less than ten minutes of that.
export function batteryDrainPerHour(events: readonly DiagEvent[]): number | null {
  const readings = events.filter((e) => e.kind === "battery" && typeof e.level === "number");
  let drop = 0;
  let ms = 0;
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    if (a.charging || b.charging) continue;
    ms += b.t - a.t;
    drop += (a.level as number) - (b.level as number);
  }
  return ms >= MIN_SPAN_MS ? round(drop / (ms / HOUR_MS)) : null;
}

// From the first to the last event of the log, in hours.
export function spanHours(events: readonly DiagEvent[]): number {
  if (events.length < 2) return 0;
  return (events[events.length - 1].t - events[0].t) / HOUR_MS;
}

export function fixesPerHour(events: readonly DiagEvent[]): Record<string, number> | null {
  const span = spanHours(events);
  if (span * HOUR_MS < MIN_SPAN_MS) return null;
  const counts: Record<string, number> = {};
  for (const e of events) if (e.kind === "fix") counts[String(e.src)] = (counts[String(e.src)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).map(([source, n]) => [source, round(n / span, 1)]));
}

// Of the fixes that went out as the position or were skipped as sent already, the share skipped.
export function duplicateRate(events: readonly DiagEvent[]): number | null {
  let live = 0;
  let dup = 0;
  for (const e of events) {
    if (e.kind !== "fix") continue;
    if (e.out === "live") live += 1;
    else if (e.out === "dup") dup += 1;
  }
  return live + dup === 0 ? null : round(dup / (live + dup), 3);
}

export function countBy(events: readonly DiagEvent[], kind: string, field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) if (e.kind === kind) counts[String(e[field])] = (counts[String(e[field])] ?? 0) + 1;
  return counts;
}

// Connections after the first one of the log, and why the socket went away.
export function connectionStats(events: readonly DiagEvent[]) {
  const socket = events.filter((e) => e.kind === "socket");
  const connects = socket.filter((e) => e.event === "connected").length;
  const reasons: Record<string, number> = {};
  for (const e of socket) {
    if (e.event !== "closed" && e.event !== "error" && e.event !== "auth-failed") continue;
    const reason = String(e.reason || e.code || e.event);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return {
    connects,
    reconnects: Math.max(0, connects - 1),
    disconnects: socket.filter((e) => e.event === "closed").length,
    authFailures: socket.filter((e) => e.event === "auth-failed").length,
    reasons,
  };
}

export function summarize(events: readonly DiagEvent[]) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const fixes = sorted.filter((e) => e.kind === "fix");
  const battery = sorted.filter((e) => e.kind === "battery");
  return {
    from: sorted.length ? new Date(sorted[0].t).toISOString() : null,
    to: sorted.length ? new Date(sorted[sorted.length - 1].t).toISOString() : null,
    hours: round(spanHours(sorted)),
    events: sorted.length,
    battery: {
      first: battery[0]?.level ?? null,
      last: battery[battery.length - 1]?.level ?? null,
      drainPerHour: batteryDrainPerHour(sorted),
    },
    fixes: {
      total: fixes.length,
      bySource: countBy(sorted, "fix", "src"),
      byOutcome: countBy(sorted, "fix", "out"),
      perHour: fixesPerHour(sorted),
      duplicateRate: duplicateRate(sorted),
      moving: fixes.filter((e) => e.moving === true).length,
      still: fixes.filter((e) => e.moving === false).length,
    },
    connection: connectionStats(sorted),
    appStates: countBy(sorted, "app", "state"),
    pushes: sorted.filter((e) => e.kind === "push").length,
    errors: sorted.filter((e) => e.kind === "error").length,
    warnings: sorted.filter((e) => e.kind === "warn").length,
  };
}

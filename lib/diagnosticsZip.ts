import { strToU8, zipSync } from "fflate";
import { sanitize, type DiagEvent, type DiagValue } from "./diagnostics";
import { summarize } from "./diagnosticsSummary";

// What the export says about the phone and the app besides the log. Collected in
// lib/diagnosticsExport, plain values only so it goes through sanitize like the log does.
export type DiagnosticsInfo = {
  username: string | null;
  device: Record<string, DiagValue>;
  app: Record<string, DiagValue>;
  permissions: Record<string, DiagValue>;
  settings: Record<string, DiagValue>;
};

const ERROR_KINDS = ["error", "warn"];

function errorsText(events: readonly DiagEvent[]): string {
  const lines = events
    .filter((e) => ERROR_KINDS.includes(e.kind))
    .map((e) => {
      const head = `${new Date(e.t).toISOString()} ${e.kind.toUpperCase()} [${e.src ?? "?"}] ${e.msg ?? ""}`;
      return e.stack ? `${head}\n    ${e.stack}` : head;
    });
  return lines.length ? `${lines.join("\n")}\n` : "No errors or warnings in the log.\n";
}

// The zip as bytes: summary.json, events.jsonl, errors.txt, settings.json.
export function buildDiagnosticsZip(events: readonly DiagEvent[], info: DiagnosticsInfo, now = Date.now()): Uint8Array {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const summary = {
    format: 1,
    exportedAt: new Date(now).toISOString(),
    username: info.username,
    device: sanitize(info.device),
    app: sanitize(info.app),
    preset: info.settings.reporting ?? null,
    permissions: sanitize(info.permissions),
    ...summarize(sorted),
  };
  return zipSync(
    {
      "summary.json": strToU8(JSON.stringify(summary, null, 2)),
      "events.jsonl": strToU8(sorted.map((e) => JSON.stringify({ ...e, at: new Date(e.t).toISOString() })).join("\n")),
      "errors.txt": strToU8(errorsText(sorted)),
      "settings.json": strToU8(JSON.stringify(sanitize(info.settings), null, 2)),
    },
    { level: 9 }
  );
}

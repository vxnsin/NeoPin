import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import chalk from "chalk";
import { config } from "./config.js";

// Diagnostics exports from the preview app: a zip of its own log, uploaded so the link can be
// pasted into a chat. Each one sits in diagnostics/ next to the database as <id>.zip with a
// small <id>.json beside it (who, which device, when it expires). The id is 128 random bits,
// the link alone is the access, so it is never listed anywhere but the admin's dialog.

export const DIAGNOSTICS_ID = /^[0-9a-f]{32}$/;
// The app caps its log at 512 KB, compressed that is far below this.
export const DIAGNOSTICS_MAX_BYTES = 5 * 1024 * 1024;
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const DAY_MS = 86_400_000;

export const diagnosticsDir = () => path.join(path.dirname(config.dbPath), "diagnostics");
const zipPath = (id) => path.join(diagnosticsDir(), `${id}.zip`);
const metaPath = (id) => path.join(diagnosticsDir(), `${id}.json`);

export class DiagnosticsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readMeta(id) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
    return meta && typeof meta.expiresAt === "string" ? meta : null;
  } catch {
    return null;
  }
}

const expired = (meta, now) => !meta || Date.parse(meta.expiresAt) <= now;

// Keeps the zip and returns its id. Only zips are taken, anything else is no export of the app.
export async function saveDiagnostics(data, { username, deviceId }, now = Date.now()) {
  const bytes = Buffer.from(data);
  if (bytes.length < ZIP_HEADER.length || !bytes.subarray(0, ZIP_HEADER.length).equals(ZIP_HEADER)) {
    throw new DiagnosticsError("not-a-zip", "The body is no zip file");
  }
  const id = crypto.randomBytes(16).toString("hex");
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + config.diagnosticsTtlDays * DAY_MS).toISOString();
  await fsp.mkdir(diagnosticsDir(), { recursive: true });
  await fsp.writeFile(zipPath(id), bytes);
  // The metadata comes last: a zip without it counts as expired and the sweep takes it.
  await fsp.writeFile(metaPath(id), JSON.stringify({ username, deviceId: deviceId ?? null, size: bytes.length, createdAt, expiresAt }));
  return { id, createdAt, expiresAt };
}

// The file behind a link, or null when the id is unknown or its time is up.
export function diagnosticsFile(id, now = Date.now()) {
  if (!DIAGNOSTICS_ID.test(id)) return null;
  if (expired(readMeta(id), now) || !fs.existsSync(zipPath(id))) return null;
  return { file: zipPath(id), size: fs.statSync(zipPath(id)).size };
}

function storedIds() {
  let names;
  try {
    names = fs.readdirSync(diagnosticsDir());
  } catch {
    return [];
  }
  const ids = new Set();
  for (const name of names) {
    const id = name.replace(/\.(zip|json)$/, "");
    if (DIAGNOSTICS_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

// The ones still valid, newest first, for the admin.
export function listDiagnostics(now = Date.now()) {
  return storedIds()
    .map((id) => ({ id, meta: readMeta(id) }))
    .filter(({ id, meta }) => !expired(meta, now) && fs.existsSync(zipPath(id)))
    .map(({ id, meta }) => ({
      id,
      username: String(meta.username ?? ""),
      deviceId: meta.deviceId == null ? null : String(meta.deviceId),
      size: Number(meta.size) || 0,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteDiagnostics(id) {
  if (!DIAGNOSTICS_ID.test(id) || (!fs.existsSync(zipPath(id)) && !fs.existsSync(metaPath(id)))) return false;
  await Promise.all([fsp.rm(zipPath(id), { force: true }), fsp.rm(metaPath(id), { force: true })]);
  return true;
}

// Removes what has expired, and halves left behind by a crash. Returns how many went.
export async function sweepDiagnostics(now = Date.now()) {
  let removed = 0;
  for (const id of storedIds()) {
    if (!expired(readMeta(id), now) && fs.existsSync(zipPath(id))) continue;
    await deleteDiagnostics(id).catch(() => {});
    removed += 1;
  }
  if (removed) console.log(chalk.cyan(`[i] Diagnostics: removed ${removed} expired export${removed === 1 ? "" : "s"}.`));
  return removed;
}

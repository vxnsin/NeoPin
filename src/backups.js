import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import chalk from "chalk";
import { config } from "./config.js";
import { currentDbFile, getDb } from "./db.js";
import { copyDatabase } from "./backupCopy.js";

// Backups are the database without the timetables (see backupCopy.js): one on request for the
// download, and one every night in backups/ next to the database, of which the newest
// BACKUP_KEEP stay. A restore is only staged here and swapped in on the next start, because
// the running server holds the file open.

// The only names served or deleted from backups/, so a name can never point anywhere else.
export const BACKUP_NAME = /^neopin-\d{4}-\d{2}-\d{2}\.db$/;
// Streamed to disk, never held in memory. A year of a family's history is far below this.
export const RESTORE_MAX_BYTES = 1024 ** 3;
const NIGHTLY = { hour: 3, minute: 30 };
const DAY_MS = 86_400_000;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

const log = (message) => console.log(chalk.cyan(`[i] Backup: ${message}`));
const warn = (message) => console.log(chalk.yellow(`[!] Backup: ${message}`));

const pad = (n) => String(n).padStart(2, "0");
// Server time, like the nightly run.
export const backupName = (date = new Date()) => `neopin-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.db`;

export const backupDir = () => path.join(path.dirname(config.dbPath), "backups");
const tempName = (base) => `${base}.${crypto.randomBytes(6).toString("hex")}.tmp`;

// A copy of the open database at `target`, off the main thread unless it lives in memory (tests).
function snapshot(target) {
  const file = currentDbFile();
  if (file === ":memory:") return Promise.resolve(copyDatabase(getDb(), target));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./backupCopy.js", import.meta.url), {
      workerData: { neopinBackup: true, source: file, target },
    });
    worker.once("message", (result) => (result.ok ? resolve() : reject(new Error(result.error))));
    worker.once("error", reject);
    worker.once("exit", (code) => code !== 0 && reject(new Error(`the copy stopped with code ${code}`)));
  });
}

// For the download: a fresh copy in a temporary folder. `chunks` streams it and removes the
// folder once the answer is out, or the client went away.
export async function downloadableBackup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "neopin-backup-"));
  const file = path.join(dir, "neopin.db");
  try {
    await snapshot(file);
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw error;
  }
  const { size } = await fsp.stat(file);
  async function* chunks() {
    try {
      for await (const chunk of fs.createReadStream(file)) yield chunk;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
  }
  return { name: backupName(), size, chunks: chunks() };
}

// The kept backups, newest first.
export function listBackups() {
  let names;
  try {
    names = fs.readdirSync(backupDir());
  } catch {
    return [];
  }
  return names
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(backupDir(), name));
      return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

// The file of a kept backup, or null for anything that is not exactly one of their names.
export function backupFile(name) {
  if (typeof name !== "string" || !BACKUP_NAME.test(name)) return null;
  const file = path.join(backupDir(), name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function rotate() {
  const removed = [];
  for (const { name } of listBackups().slice(config.backupKeep)) {
    fs.rmSync(path.join(backupDir(), name), { force: true });
    removed.push(name);
  }
  return removed;
}

let running = null;

// Writes today's backup (a second one on the same day replaces it) and drops the oldest.
// One at a time, a second call joins the one in progress.
export function runBackup(now = new Date()) {
  if (!running) running = writeBackup(now).finally(() => (running = null));
  return running;
}

async function writeBackup(now) {
  const dir = backupDir();
  await fsp.mkdir(dir, { recursive: true });
  const name = backupName(now);
  const tmp = tempName(path.join(dir, `.${name}`));
  try {
    await snapshot(tmp);
    await fsp.rename(tmp, path.join(dir, name));
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }
  return { name, removed: rotate() };
}

// How long until the next 03:30 of the server's clock.
export function msUntilNightly(now = new Date()) {
  const next = new Date(now);
  next.setHours(NIGHTLY.hour, NIGHTLY.minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// A server that was off at night catches up after the start.
export function backupDue(now = Date.now()) {
  const newest = listBackups().reduce((max, b) => Math.max(max, Date.parse(b.createdAt)), 0);
  return now - newest > DAY_MS;
}

export function startBackups({ delayMs = 60_000 } = {}) {
  if (!config.backups) return { stop() {} };
  const run = () =>
    runBackup()
      .then(({ name, removed }) => log(`${name} written${removed.length ? `, ${removed.length} old one(s) removed` : ""}`))
      .catch((error) => warn(`failed: ${error.message}`));
  let nightly = null;
  const plan = () => {
    nightly = setTimeout(() => run().finally(plan), msUntilNightly());
    nightly.unref?.();
  };
  const first = backupDue() ? setTimeout(run, delayMs) : null;
  first?.unref?.();
  plan();
  return {
    stop() {
      clearTimeout(first);
      clearTimeout(nightly);
    },
  };
}

// ---- restore ----

export const stagedRestoreFile = (file = config.dbPath) => `${file}.restore`;
export const beforeRestoreFile = (file = config.dbPath) => `${file}.before-restore`;

const invalid = (message) => Object.assign(new Error(message), { code: "invalid-backup" });

// Throws unless the file is a sound SQLite database with NeoPin's accounts and history in it.
export function checkBackup(file) {
  const head = Buffer.alloc(SQLITE_HEADER.length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.equals(SQLITE_HEADER)) throw invalid("This is no SQLite database");
  let db;
  try {
    db = new DatabaseSync(file);
    // One file on its own, so it can be moved into place as it is.
    db.exec("PRAGMA journal_mode = DELETE");
    const check = db.prepare("PRAGMA quick_check").get();
    if (Object.values(check ?? {})[0] !== "ok") throw invalid("The database is damaged");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (!tables.has("users") || !tables.has("positions")) throw invalid("This is no NeoPin database");
  } catch (error) {
    throw error.code === "invalid-backup" ? error : invalid(`The database cannot be read: ${error.message}`);
  } finally {
    db?.close();
  }
}

// Writes the uploaded bytes next to the database and keeps them only when checkBackup passes.
// A staged restore that was not applied yet is replaced.
export async function stageRestore(chunks, file = config.dbPath) {
  const target = stagedRestoreFile(file);
  const tmp = tempName(target);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeline(Readable.from(chunks), fs.createWriteStream(tmp));
    checkBackup(tmp);
    await fsp.rename(tmp, target);
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }
  return { size: (await fsp.stat(target)).size };
}

export const restorePending = (file = config.dbPath) => fs.existsSync(stagedRestoreFile(file));

// At startup, before the database is opened: a staged restore takes the place of the database,
// the old one stays as .before-restore. True when one was applied.
export function applyStagedRestore(file = config.dbPath) {
  const staged = stagedRestoreFile(file);
  if (!fs.existsSync(staged)) return false;
  if (fs.existsSync(file)) {
    // Folds the write-ahead log into the old file first: the copy that is kept is whole,
    // and no stale -wal of it is ever read into the restored one.
    const old = new DatabaseSync(file);
    try {
      old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      old.exec("PRAGMA journal_mode = DELETE");
    } finally {
      old.close();
    }
    fs.renameSync(file, beforeRestoreFile(file));
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(file + suffix, { force: true });
  fs.renameSync(staged, file);
  return true;
}

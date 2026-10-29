import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

// The timetables are a copy of public GTFS feeds and can be most of the file. The server
// imports them again on its own, so a backup leaves them out.
const TIMETABLE_TABLES = [
  "transit_shapes",
  "transit_stop_times",
  "transit_trips",
  "transit_routes",
  "transit_stops",
  "transit_feeds",
  "transit_osm_cache",
  "transit_regions",
];

// VACUUM INTO writes a consistent copy while the server keeps writing (WAL), then the copy
// loses its timetables and is packed again. `source` is an open database or a file path.
export function copyDatabase(source, target) {
  const db = typeof source === "string" ? new DatabaseSync(source, { timeout: 10_000 }) : source;
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    if (db !== source) db.close();
  }
  const copy = new DatabaseSync(target);
  try {
    // One self-contained file, no -wal next to it.
    copy.exec("PRAGMA journal_mode = DELETE");
    const present = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    copy.exec("BEGIN");
    for (const table of TIMETABLE_TABLES) if (present.has(table)) copy.exec(`DELETE FROM ${table}`);
    copy.exec("COMMIT");
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
}

// Run as a worker, so a large database does not stop the server while it is copied.
if (!isMainThread && workerData?.neopinBackup) {
  try {
    copyDatabase(workerData.source, workerData.target);
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message });
  }
}

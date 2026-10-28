import fs from "node:fs";
import { Inflate } from "fflate";

// Reads GTFS tables straight out of a feed ZIP, one line at a time, so a feed of a few
// hundred MB (all of Germany) is never unpacked. The central directory at the end of the
// file says where each table starts, fflate inflates it while it streams from disk.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const ZIP64_EXTRA = 0x0001;
const MAX32 = 0xffffffff;

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("ZIP file is truncated");
  return buffer;
}

function findSignature(buffer, signature) {
  for (let i = buffer.length - 4; i >= 0; i--) if (buffer.readUInt32LE(i) === signature) return i;
  return -1;
}

// Sizes and offsets that do not fit 32 bits sit in the ZIP64 extra field, in a fixed order.
function zip64(extra, sizes) {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === ZIP64_EXTRA) {
      let p = at + 4;
      for (const key of ["size", "compressedSize", "offset"]) {
        if (sizes[key] === MAX32 && p + 8 <= at + 4 + length) {
          sizes[key] = Number(extra.readBigUInt64LE(p));
          p += 8;
        }
      }
    }
    at += 4 + length;
  }
  return sizes;
}

// The tables in a ZIP: name, compression method, sizes and where the local header starts.
export async function zipEntries(file) {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    // The end record is followed only by a comment of at most 64 KiB.
    const tailLength = Math.min(size, 65_557 + 20);
    const tail = await readAt(handle, size - tailLength, tailLength);
    const eocd = findSignature(tail, EOCD_SIG);
    if (eocd < 0) throw new Error("not a ZIP file");
    let count = tail.readUInt16LE(eocd + 10);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    let directorySize = tail.readUInt32LE(eocd + 12);
    if (count === 0xffff || directoryOffset === MAX32 || directorySize === MAX32) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== EOCD64_LOCATOR_SIG) throw new Error("ZIP64 end record is missing");
      const record = await readAt(handle, Number(tail.readBigUInt64LE(locator + 8)), 56);
      if (record.readUInt32LE(0) !== EOCD64_SIG) throw new Error("ZIP64 end record is damaged");
      count = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
    const directory = await readAt(handle, directoryOffset, directorySize);
    const entries = [];
    let at = 0;
    for (let i = 0; i < count && at + 46 <= directory.length; i++) {
      if (directory.readUInt32LE(at) !== CENTRAL_SIG) throw new Error("ZIP central directory is damaged");
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      const sizes = zip64(directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength), {
        compressedSize: directory.readUInt32LE(at + 20),
        size: directory.readUInt32LE(at + 24),
        offset: directory.readUInt32LE(at + 42),
      });
      entries.push({ name, method: directory.readUInt16LE(at + 10), ...sizes });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

// The lines of one entry, decoded as UTF-8 (a byte order mark is dropped), without line breaks.
export async function* entryLines(file, entry) {
  const handle = await fs.promises.open(file, "r");
  let start;
  try {
    const header = await readAt(handle, entry.offset, 30);
    if (header.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`${entry.name}: local header is damaged`);
    start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: unsupported compression ${entry.method}`);
  if (entry.compressedSize === 0) return;

  const decoder = new TextDecoder("utf-8");
  let rest = "";
  let lines = [];
  const take = (bytes, final) => {
    const parts = (rest + decoder.decode(bytes, { stream: !final })).split("\n");
    rest = parts.pop();
    for (const part of parts) lines.push(part.endsWith("\r") ? part.slice(0, -1) : part);
    if (final && rest) {
      lines.push(rest.endsWith("\r") ? rest.slice(0, -1) : rest);
      rest = "";
    }
  };
  const inflate = entry.method === 8 ? new Inflate((data, final) => take(data, final)) : null;
  const stream = fs.createReadStream(file, { start, end: start + entry.compressedSize - 1, highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    if (inflate) inflate.push(chunk, false);
    else take(chunk, false);
    if (lines.length) {
      const ready = lines;
      lines = [];
      yield* ready;
    }
  }
  if (inflate) inflate.push(new Uint8Array(0), true);
  take(new Uint8Array(0), true);
  yield* lines;
}

// One CSV line into its fields. Quoted fields may hold commas and doubled quotes.
export function parseCsvLine(line) {
  if (!line.includes('"')) return line.split(",");
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (line[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

// Streams one table of the feed. `setup` gets a column lookup (name to index, -1 when the
// table lacks it) and returns the row handler, which gets the fields of every row. Resolves
// to false when the feed has no such table (shapes.txt is optional, for example).
export async function readTable(file, entries, name, setup) {
  // Some feeds are zipped inside a folder.
  const entry = entries.find((e) => e.name === name) ?? entries.find((e) => e.name.endsWith("/" + name));
  if (!entry) return false;
  let onRow = null;
  for await (const line of entryLines(file, entry)) {
    if (!onRow) {
      const header = parseCsvLine(line).map((h) => h.trim());
      onRow = setup((column) => header.indexOf(column));
      if (!onRow) return true;
      continue;
    }
    if (line === "") continue;
    onRow(parseCsvLine(line));
  }
  return true;
}

// "25:10:00" are seconds since midnight of the service day, also past 24 hours. Null when empty.
export function gtfsSeconds(time) {
  const match = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(time ?? "");
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { strFromU8, unzipSync } from "fflate";
import {
  MAX_BYTES,
  MAX_EVENTS,
  clearDiagnostics,
  diagnosticsEvents,
  logBattery,
  logError,
  logEvent,
  logFix,
  resetDiagnostics,
  sanitize,
  saveDiagnostics,
  scrubText,
  setDiagnosticsEnabled,
  type DiagEvent,
} from "../lib/diagnostics";
import { batteryDrainPerHour, connectionStats, duplicateRate, fixesPerHour, summarize } from "../lib/diagnosticsSummary";
import { buildDiagnosticsZip, type DiagnosticsInfo } from "../lib/diagnosticsZip";

const STORAGE_KEY = "neopin.diagnostics";
const T0 = Date.UTC(2026, 10, 2, 8, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const TOKEN = "f3a9c1d2e4b5a6978877665544332211aabbccddeeff00112233445566778899";

beforeEach(async () => {
  await AsyncStorage.clear();
  resetDiagnostics();
  setDiagnosticsEnabled(true);
});

afterAll(() => setDiagnosticsEnabled(false));

const at = (t: number, kind: string, fields: Record<string, any> = {}) => ({ t, kind, ...fields }) as DiagEvent;

describe("the log", () => {
  test("keeps nothing while it is off, as in store builds", async () => {
    setDiagnosticsEnabled(false);
    logEvent("app", { state: "active" });
    logFix("foreground", { latitude: 49.79, longitude: 9.95 }, "live");
    logBattery({ level: 80, charging: false });
    expect(await diagnosticsEvents()).toEqual([]);
  });

  test("keeps at most 2000 events, the newest", async () => {
    for (let i = 0; i < MAX_EVENTS + 50; i++) logEvent("tick", { i }, T0 + i);
    const events = await diagnosticsEvents();
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events[0].i).toBe(50);
    expect(events[events.length - 1].i).toBe(MAX_EVENTS + 49);
  });

  test("stays below 512 KB however long the messages are", async () => {
    const long = "slow ".repeat(58);
    for (let i = 0; i < 1_900; i++) logEvent("warn", { src: "console", msg: long, n: i }, T0 + i);
    const events = await diagnosticsEvents();
    expect(JSON.stringify(events).length).toBeLessThanOrEqual(MAX_BYTES + events.length);
    expect(events.length).toBeLessThan(1_900);
    expect(events[events.length - 1].n).toBe(1_899);
  });

  test("survives a restart through AsyncStorage, older events first", async () => {
    logEvent("app", { state: "background" }, T0);
    logEvent("app", { state: "active" }, T0 + MIN);
    await saveDiagnostics();
    resetDiagnostics();
    setDiagnosticsEnabled(true);
    logEvent("start", {}, T0 + 2 * MIN);
    const events = await diagnosticsEvents();
    expect(events.map((e) => e.kind)).toEqual(["app", "app", "start"]);
    expect(events[0].state).toBe("background");
  });

  test("starts over when the stored log is broken, and clearing empties the store", async () => {
    await AsyncStorage.setItem(STORAGE_KEY, "{not json");
    logEvent("start", {}, T0);
    expect(await diagnosticsEvents()).toHaveLength(1);
    await clearDiagnostics();
    expect(await diagnosticsEvents()).toEqual([]);
    expect(JSON.parse((await AsyncStorage.getItem(STORAGE_KEY))!)).toEqual([]);
  });

  test("logs the battery only when it changes", async () => {
    logBattery({ level: 80, charging: false }, T0);
    logBattery({ level: 80, charging: false }, T0 + MIN);
    logBattery({ level: 79, charging: false }, T0 + 2 * MIN);
    logBattery({ level: 79, charging: true }, T0 + 3 * MIN);
    logBattery(null, T0 + 4 * MIN);
    expect((await diagnosticsEvents()).map((e) => [e.level, e.charging])).toEqual([
      [80, false],
      [79, false],
      [79, true],
    ]);
  });
});

describe("privacy", () => {
  test("a fix is stored as the distance to the one before, never with its coordinates", async () => {
    logFix("foreground", { latitude: 49.791234, longitude: 9.953456, accuracy: 8.4, speed: 0, recordedAt: T0 - 2_000 }, "live", T0);
    logFix("background", { latitude: 49.792234, longitude: 9.953456, accuracy: 12, speed: 3.2, recordedAt: T0 + 9_000 }, "dup", T0 + 10_000);
    const events = await diagnosticsEvents();
    expect(events[0]).toEqual({ t: T0, kind: "fix", src: "foreground", out: "live", acc: 8, spd: 0, dm: null, age: 2, moving: false });
    expect(events[1]).toMatchObject({ src: "background", out: "dup", dm: 111, moving: true, age: 1 });

    await saveDiagnostics();
    const stored = (await AsyncStorage.getItem(STORAGE_KEY))!;
    for (const raw of ["49.79", "9.95", "latitude", "longitude"]) expect(stored).not.toContain(raw);
  });

  test("keys that may hold a secret or a position are dropped, nested values too", () => {
    expect(
      sanitize({
        token: TOKEN,
        password: "hunter2",
        Authorization: `Bearer ${TOKEN}`,
        latitude: 49.79,
        lng: 9.95,
        coords: { latitude: 1 },
        serverIp: "wss://neopin.example.com",
        pushToken: "ExponentPushToken[abc]",
        nested: { token: TOKEN },
        level: 64,
        ok: true,
      })
    ).toEqual({ level: 64, ok: true });
  });

  test("free text loses tokens and coordinates", () => {
    const text = scrubText(
      `Request failed: Authorization: Bearer ${TOKEN} at 49.791234, 9.953456 {"token":"abc123","latitude":49.79} wss://x/?token=s3cret`
    );
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("49.79");
    expect(text).not.toContain("9.953456");
    expect(text).toContain("Request failed");
  });

  test("errors keep their message and a short stack, scrubbed the same way", async () => {
    const error = new Error(`auth ${TOKEN} refused`);
    logError("uncaught", error, T0);
    const [event] = await diagnosticsEvents();
    expect(event).toMatchObject({ kind: "error", src: "uncaught" });
    expect(String(event.msg)).toBe("auth [redacted] refused");
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });
});

describe("the summary", () => {
  test("battery drain counts the time off the charger only", () => {
    const events = [
      at(T0, "battery", { level: 80, charging: false }),
      at(T0 + HOUR, "battery", { level: 76, charging: false }),
      // An hour on the charger is left out.
      at(T0 + 1.5 * HOUR, "battery", { level: 90, charging: true }),
      at(T0 + 2.5 * HOUR, "battery", { level: 95, charging: false }),
      at(T0 + 3.5 * HOUR, "battery", { level: 93, charging: false }),
    ];
    // 4 % in the first hour, the jump to the charger is skipped, 2 % in the last: 6 % in 2 h.
    expect(batteryDrainPerHour(events)).toBe(3);
    expect(batteryDrainPerHour(events.slice(0, 1))).toBeNull();
    expect(batteryDrainPerHour([at(T0, "battery", { level: 80 }), at(T0 + MIN, "battery", { level: 79 })])).toBeNull();
  });

  test("fixes per hour and source, and the duplicate rate", () => {
    const events: DiagEvent[] = [];
    // Two hours: 120 foreground fixes, every fourth one sent by the background task already,
    // and 30 background fixes.
    for (let i = 0; i < 120; i++) events.push(at(T0 + i * MIN, "fix", { src: "foreground", out: i % 4 === 0 ? "dup" : "live" }));
    for (let i = 0; i < 30; i++) events.push(at(T0 + i * 4 * MIN, "fix", { src: "background", out: "batch" }));
    events.push(at(T0 + 2 * HOUR, "app", { state: "background" }));
    expect(fixesPerHour(events)).toEqual({ foreground: 60, background: 15 });
    expect(duplicateRate(events)).toBe(0.25);
    expect(duplicateRate([])).toBeNull();
    expect(fixesPerHour(events.slice(0, 3))).toBeNull();
  });

  test("reconnects are connections after the first, with what closed them", () => {
    const events = [
      at(T0, "socket", { event: "connected" }),
      at(T0 + MIN, "socket", { event: "closed", code: 1006, reason: "" }),
      at(T0 + 2 * MIN, "socket", { event: "connected" }),
      at(T0 + 3 * MIN, "socket", { event: "closed", code: 1001, reason: "Going away" }),
      at(T0 + 4 * MIN, "socket", { event: "connected" }),
      at(T0 + 5 * MIN, "socket", { event: "auth-failed" }),
    ];
    expect(connectionStats(events)).toEqual({
      connects: 3,
      reconnects: 2,
      disconnects: 2,
      authFailures: 1,
      reasons: { "1006": 1, "Going away": 1, "auth-failed": 1 },
    });
  });
});

describe("the zip", () => {
  const info: DiagnosticsInfo = {
    username: "luis",
    device: { platform: "android", model: "Pixel 9", osVersion: "16", token: TOKEN },
    app: { version: "1.11.0", channel: "preview", runtimeVersion: "1.11.0", updateId: "60ac4d5f-1111" },
    permissions: { foreground: "granted", background: "granted", notifications: "denied" },
    settings: { reporting: "balanced", map3d: false, serverIp: "wss://neopin.example.com", password: "hunter2" },
  };

  test("holds the summary, the events, the errors and the settings", async () => {
    logEvent("start", { version: "1.11.0" }, T0);
    logBattery({ level: 80, charging: false }, T0);
    logFix("foreground", { latitude: 49.791234, longitude: 9.953456, accuracy: 8, recordedAt: T0 }, "live", T0 + 1_000);
    logFix("background", { latitude: 49.791234, longitude: 9.953456, accuracy: 8, recordedAt: T0 }, "dup", T0 + 1_500);
    logEvent("socket", { event: "connected", features: 2 }, T0 + 2_000);
    logError("console", `Background push failed: Bearer ${TOKEN}`, T0 + 3_000);
    logBattery({ level: 70, charging: false }, T0 + 2 * HOUR);

    const zip = buildDiagnosticsZip(await diagnosticsEvents(), info, T0 + 2 * HOUR);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(["errors.txt", "events.jsonl", "settings.json", "summary.json"]);

    const summary = JSON.parse(strFromU8(files["summary.json"]));
    expect(summary).toMatchObject({
      username: "luis",
      preset: "balanced",
      device: { platform: "android", model: "Pixel 9" },
      app: { channel: "preview" },
      permissions: { notifications: "denied" },
      battery: { first: 80, last: 70, drainPerHour: 5 },
      fixes: { total: 2, duplicateRate: 0.5, byOutcome: { live: 1, dup: 1 } },
      connection: { connects: 1, reconnects: 0 },
      errors: 1,
    });

    const lines = strFromU8(files["events.jsonl"]).split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatchObject({ kind: "start", at: new Date(T0).toISOString() });

    expect(strFromU8(files["errors.txt"])).toContain("ERROR [console] Background push failed: Bearer [redacted]");
    expect(JSON.parse(strFromU8(files["settings.json"]))).toEqual({ reporting: "balanced", map3d: false });

    // Nothing in the whole zip gives away where the phone was, or how to log in.
    const all = Object.values(files).map((f) => strFromU8(f)).join("\n");
    for (const secret of [TOKEN, "hunter2", "neopin.example.com", "49.79", "9.95", "latitude"]) expect(all).not.toContain(secret);
  });

  test("an empty log still makes a readable export", () => {
    const files = unzipSync(buildDiagnosticsZip([], info, T0));
    expect(JSON.parse(strFromU8(files["summary.json"]))).toMatchObject({ events: 0, from: null, battery: { drainPerHour: null } });
    expect(strFromU8(files["errors.txt"])).toBe("No errors or warnings in the log.\n");
    expect(summarize([]).fixes.perHour).toBeNull();
  });
});

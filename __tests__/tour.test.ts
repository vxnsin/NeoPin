jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { markTourSeen } from "../lib/api";
import {
  accountKey,
  dashboardUrl,
  finishTour,
  loadLocalTour,
  onScreen,
  scrollToShow,
  showSetupBanner,
  tourInterrupted,
  tourMayOpen,
  tourSeen,
  tourSteps,
} from "../lib/tour";

const auth = { serverIp: "wss://neopin.example.org", deviceId: "Pixel", token: "tok" };
const account = accountKey(auth, 7);
const none = { device: false, accounts: [] };

const respond = (status: number, body: unknown = {}) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

beforeEach(async () => {
  await AsyncStorage.clear();
});

afterEach(() => {
  (global as any).fetch = undefined;
});

test("one short step per control, the admin gets the dashboard one at the end", () => {
  const steps = tourSteps(false);
  expect(steps.map((s) => s.key)).not.toContain("dashboard");
  const admin = tourSteps(true);
  expect(admin).toHaveLength(steps.length + 1);
  expect(admin[admin.length - 1].key).toBe("dashboard");
  expect(admin[admin.length - 1].text).toMatch(/dashboard/i);
  for (const step of admin) {
    expect(step.title.length).toBeLessThan(24);
    expect(step.text.length).toBeLessThan(90);
  }
  // Only the opening map step and the dashboard have nothing to point at; no control twice.
  const targets = admin.map((s) => s.target);
  expect(targets.filter((t) => t === null)).toHaveLength(2);
  const controls = targets.filter(Boolean);
  expect(new Set(controls).size).toBe(controls.length);
});

test("the controls Luis listed each get their step", () => {
  const targets = tourSteps(false).map((s) => s.target);
  for (const t of ["peopleBar", "groupChips", "personRow", "findButton", "refreshButton", "timelineButton", "settingsButton", "profile", "groupsEntry", "inviteCodesEntry", "alertsEntry", "presets", "sharingEntry"])
    expect(targets).toContain(t);
});

test("each sheet is opened once: map, people, settings, then the map again for the admin", () => {
  const order = tourSteps(true)
    .map((s) => s.sheet)
    .filter((sheet, i, all) => i === 0 || sheet !== all[i - 1]);
  expect(order).toEqual([null, "devices", "settings", null]);
  // The map controls are on the map, the list ones on the people sheet.
  const byKey = Object.fromEntries(tourSteps(false).map((s) => [s.target, s.sheet]));
  expect(byKey.peopleBar).toBeNull();
  expect(byKey.settingsButton).toBeNull();
  expect(byKey.findButton).toBe("devices");
  expect(byKey.groupChips).toBe("devices");
  expect(byKey.presets).toBe("settings");
});

test("a control counts as on screen only when all of it is visible", () => {
  const screen = { x: 0, y: 0, width: 400, height: 800 };
  expect(onScreen({ x: 10, y: 700, width: 380, height: 68 }, screen)).toBe(true);
  expect(onScreen({ x: 10, y: 760, width: 380, height: 68 }, screen)).toBe(false);
  expect(onScreen({ x: -5, y: 100, width: 40, height: 40 }, screen)).toBe(false);
  // A view that is laid out but has no size is not there either.
  expect(onScreen({ x: 10, y: 10, width: 0, height: 0 }, screen)).toBe(false);
});

test("a control below the fold is scrolled to a little above the middle", () => {
  // 1000 down on an 800 screen, list at 0: scroll by 1000 - 320.
  expect(scrollToShow({ x: 0, y: 1000, width: 300, height: 52 }, 800, 0)).toBe(680);
  expect(scrollToShow({ x: 0, y: 1000, width: 300, height: 52 }, 800, 100)).toBe(780);
  // Never above the top.
  expect(scrollToShow({ x: 0, y: 50, width: 300, height: 52 }, 800, 0)).toBe(0);
});

test("a sheet the tour did not open puts it off", () => {
  expect(tourInterrupted(null)).toBe(false);
  expect(tourInterrupted("devices")).toBe(false);
  expect(tourInterrupted("settings")).toBe(false);
  expect(tourInterrupted("find")).toBe(true);
  expect(tourInterrupted("notifications")).toBe(true);
});

test("the server's word decides when it has one", () => {
  expect(tourSeen({ tours: { app: false, dashboard: true } }, none, account)).toBe(false);
  expect(tourSeen({ tours: { app: true, dashboard: false } }, none, account)).toBe(true);
  // An older device flag does not count for a server that knows tours: a new account still gets it.
  expect(tourSeen({ tours: { app: false, dashboard: false } }, { device: true, accounts: [] }, account)).toBe(false);
  // Seen here while the server could not be told.
  expect(tourSeen({ tours: { app: false, dashboard: false } }, { device: true, accounts: [account] }, account)).toBe(true);
  expect(tourSeen({ tours: { app: false, dashboard: false } }, { device: true, accounts: ["other#7"] }, account)).toBe(false);
});

test("an older server without tours: once per device", () => {
  expect(tourSeen({}, none, account)).toBe(false);
  expect(tourSeen({}, { device: true, accounts: [] }, account)).toBe(true);
});

test("only on the bare map", () => {
  const free = { mapReady: true, sheetOpen: false, cropOpen: false, timelineOpen: false };
  expect(tourMayOpen(free)).toBe(true);
  expect(tourMayOpen({ ...free, mapReady: false })).toBe(false);
  // A ride question, the settings with the password form, a find request: all sheets.
  expect(tourMayOpen({ ...free, sheetOpen: true })).toBe(false);
  expect(tourMayOpen({ ...free, cropOpen: true })).toBe(false);
  expect(tourMayOpen({ ...free, timelineOpen: true })).toBe(false);
});

test("marking it seen posts the client to the server", async () => {
  const fetchMock = respond(204);
  (global as any).fetch = fetchMock;
  await expect(markTourSeen(auth, "app")).resolves.toBe(true);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://neopin.example.org/api/me/tours");
  expect(init.method).toBe("POST");
  expect(init.headers.Authorization).toBe("Bearer tok");
  expect(JSON.parse(init.body)).toEqual({ client: "app" });
  (global as any).fetch = respond(404);
  await expect(markTourSeen(auth, "app")).resolves.toBe(false);
  (global as any).fetch = respond(500, { detail: "Broken" });
  await expect(markTourSeen(auth, "app")).rejects.toThrow("Broken");
});

test("finishing tells the server, and leaves the device alone when it listened", async () => {
  (global as any).fetch = respond(204);
  await expect(finishTour(auth, 7)).resolves.toBe("server");
  expect(await loadLocalTour()).toEqual(none);
});

test("an older server (404) or no connection: the device remembers it", async () => {
  (global as any).fetch = respond(404);
  await expect(finishTour(auth, 7)).resolves.toBe("device");
  expect(await loadLocalTour()).toEqual({ device: true, accounts: [account] });
  (global as any).fetch = jest.fn().mockRejectedValue(new TypeError("Network request failed"));
  await expect(finishTour(auth, 7)).resolves.toBe("device");
  // Once per account, not twice.
  expect((await loadLocalTour()).accounts).toEqual([account]);
  expect(tourSeen({}, await loadLocalTour(), account)).toBe(true);
  expect(tourSeen({ tours: { app: false, dashboard: false } }, await loadLocalTour(), account)).toBe(true);
});

test("a broken local record reads as nothing seen", async () => {
  await AsyncStorage.setItem("tour.app", "{not json");
  expect(await loadLocalTour()).toEqual(none);
  await AsyncStorage.setItem("tour.app", JSON.stringify({ device: "yes", accounts: [1, "a"] }));
  expect(await loadLocalTour()).toEqual({ device: false, accounts: ["a"] });
});

test("the setup banner is for an admin whose server still needs it, until dismissed", () => {
  expect(showSetupBanner({ isAdmin: true, setupNeeded: true }, false)).toBe(true);
  expect(showSetupBanner({ isAdmin: true, setupNeeded: true }, true)).toBe(false);
  expect(showSetupBanner({ isAdmin: true, setupNeeded: false }, false)).toBe(false);
  // Older servers send nothing.
  expect(showSetupBanner({ isAdmin: true }, false)).toBe(false);
  expect(showSetupBanner({ isAdmin: false, setupNeeded: true }, false)).toBe(false);
});

test("the dashboard lives at the server's web address", () => {
  expect(dashboardUrl("wss://neopin.example.org/")).toBe("https://neopin.example.org");
  expect(dashboardUrl("ws://192.168.2.128:3012")).toBe("http://192.168.2.128:3012");
});

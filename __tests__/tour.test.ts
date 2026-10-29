jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { markTourSeen } from "../lib/api";
import {
  accountKey,
  dashboardUrl,
  finishTour,
  loadLocalTour,
  showSetupBanner,
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

test("five or six short steps, the admin gets the dashboard one at the end", () => {
  const steps = tourSteps(false);
  expect(steps.length).toBeGreaterThanOrEqual(5);
  expect(steps.length).toBeLessThanOrEqual(6);
  expect(steps.map((s) => s.key)).not.toContain("dashboard");
  const admin = tourSteps(true);
  expect(admin).toHaveLength(steps.length + 1);
  expect(admin[admin.length - 1].key).toBe("dashboard");
  expect(admin[admin.length - 1].text).toMatch(/dashboard/i);
  // Every step says what it is about in a few words and points somewhere.
  for (const step of admin) {
    expect(step.title.length).toBeLessThan(30);
    expect(step.text.length).toBeLessThan(140);
    expect(["map", "people", "timeline", "settings"]).toContain(step.target);
  }
});

test("the steps cover the map, Find, the timeline, groups and the settings", () => {
  const text = tourSteps(false)
    .map((s) => `${s.title} ${s.text}`)
    .join(" ");
  for (const word of [/map/i, /Find/, /timeline/i, /groups/i, /invite code/i, /arrive/i, /battery/i]) expect(text).toMatch(word);
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

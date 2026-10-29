import { fetchTimeline, fetchTimelinePeople, getTimelineSharing, setTimelineSharing } from "../lib/api";
import { canEditTimeline, devicesOf, peopleFromAccounts } from "../lib/timelinePeople";

const auth = { serverIp: "ws://10.0.0.2:3012", deviceId: "Pixel", token: "tok" };

afterEach(() => {
  (global as any).fetch = undefined;
});

const respond = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

test("the sharing setting is read, and a server without it answers 404, which reads as null", async () => {
  const fetchMock = respond(200, { mode: "groups", users: [], groups: [] });
  (global as any).fetch = fetchMock;
  await expect(getTimelineSharing(auth)).resolves.toEqual({ mode: "groups", users: [], groups: [] });
  expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.2:3012/api/timeline/sharing");
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  (global as any).fetch = respond(404, {});
  await expect(getTimelineSharing(auth)).resolves.toBeNull();
});

test("saving puts mode, people and groups", async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error("no body"); } });
  (global as any).fetch = fetchMock;
  await setTimelineSharing(auth, { mode: "selected", users: [4], groups: [2] });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/timeline/sharing");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({ mode: "selected", users: [4], groups: [2] });
  (global as any).fetch = respond(400, { detail: "Unknown group" });
  await expect(setTimelineSharing(auth, { mode: "selected", users: [], groups: [9] })).rejects.toThrow("Unknown group");
});

test("the people with a readable timeline come from their own list, null on older servers", async () => {
  const people = [{ userId: 1, displayName: "Luis", avatarUrl: null, devices: ["Pixel"] }];
  const fetchMock = respond(200, people);
  (global as any).fetch = fetchMock;
  await expect(fetchTimelinePeople(auth)).resolves.toEqual(people);
  expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.2:3012/api/timeline/people");
  (global as any).fetch = respond(404, {});
  await expect(fetchTimelinePeople(auth)).resolves.toBeNull();
});

test("someone else's day is asked for with their userId, a refusal is a 403", async () => {
  const fetchMock = respond(200, { date: "2026-10-29", segments: [] });
  (global as any).fetch = fetchMock;
  await fetchTimeline(auth, "Kaspars Pixel", "2026-10-29", 4);
  expect(fetchMock.mock.calls[0][0]).toContain("/api/timeline?deviceId=Kaspars%20Pixel&userId=4&tz=");
  (global as any).fetch = respond(403, { detail: "Not shared with you" });
  await expect(fetchTimeline(auth, "Kaspars Pixel", "2026-10-29", 4)).rejects.toMatchObject({ status: 403 });
});

test("the admin's account list stands in on older servers", () => {
  const accounts = [{ id: 1, username: "luis", displayName: "Luis", avatarUrl: "/a/1", devices: 2 }];
  expect(peopleFromAccounts(accounts)).toEqual([{ userId: 1, displayName: "Luis", avatarUrl: "/a/1", devices: [] }]);
});

test("a shared person's devices carry what the map knows about them", () => {
  const person = { userId: 4, displayName: "Kaspar", avatarUrl: "/a/4", devices: ["Phone", "Tablet"] };
  const map = [
    { deviceId: "Phone", userId: 4, position: null, lastPing: "x", status: "online" as const, avatarUrl: null, deviceType: "phone" as const },
    { deviceId: "Tablet", userId: 9, position: null, lastPing: null, status: "online" as const },
  ];
  const [phone, tablet] = devicesOf(person, map);
  expect(phone).toMatchObject({ deviceId: "Phone", status: "online", deviceType: "phone", avatarUrl: "/a/4" });
  // Another account's device with the same name is not theirs.
  expect(tablet).toMatchObject({ deviceId: "Tablet", userId: 4, status: "offline", avatarUrl: "/a/4" });
});

test("only the owner and the admin may change a day", () => {
  expect(canEditTimeline(false, false)).toBe(true);
  expect(canEditTimeline(true, false)).toBe(false);
  expect(canEditTimeline(true, true)).toBe(true);
});

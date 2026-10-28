import {
  ApiError,
  deviceHeaders,
  fetchTimeline,
  fetchTimelineDays,
  loginRequest,
  normalizeServerUrl,
  pingDeviceRequest,
  savePlaceAt,
} from "../lib/api";

const auth = { serverIp: "ws://10.0.0.2:3012", deviceId: "Luis’ iPhone", token: "t/k+1" };

afterEach(() => {
  (global as any).fetch = undefined;
});

const respond = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

test("addresses without a scheme become ws://", () => {
  expect(normalizeServerUrl(" 192.168.1.20:3012 ")).toBe("ws://192.168.1.20:3012");
  expect(normalizeServerUrl("wss://pin.example.com")).toBe("wss://pin.example.com");
  expect(normalizeServerUrl("https://pin.trycloudflare.com/")).toBe("wss://pin.trycloudflare.com");
  expect(normalizeServerUrl("pin.trycloudflare.com")).toBe("wss://pin.trycloudflare.com");
  expect(normalizeServerUrl("localhost:3012")).toBe("ws://localhost:3012");
  expect(normalizeServerUrl("my-server:3012")).toBe("ws://my-server:3012");
});

test("device headers carry the token, percent-encoded", () => {
  const headers = deviceHeaders(auth);
  expect(headers.Authorization).toBe("Bearer t%2Fk%2B1");
  expect(headers["X-Device-Id"]).toBe("Luis%E2%80%99%20iPhone");
});

test("a login posts the device with the credentials and returns the token", async () => {
  const fetchMock = respond(200, { token: "tok", user: { id: 1 } });
  (global as any).fetch = fetchMock;
  const result = await loginRequest("ws://10.0.0.2:3012", { username: "luis", password: "pw", deviceId: "iPhone" });
  expect(result.token).toBe("tok");
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/auth/login");
  expect(JSON.parse(init.body)).toEqual({ username: "luis", password: "pw", deviceId: "iPhone" });
});

test("a login can carry the device type", async () => {
  const fetchMock = respond(200, { token: "tok", user: { id: 1 } });
  (global as any).fetch = fetchMock;
  await loginRequest("ws://10.0.0.2:3012", { username: "luis", password: "pw", deviceId: "iPad", deviceType: "tablet" });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).deviceType).toBe("tablet");
});

test("the server message is shown", async () => {
  (global as any).fetch = respond(401, { detail: "Wrong username or password" });
  await expect(loginRequest("ws://x", { username: "a", password: "b", deviceId: "c" })).rejects.toThrow("Wrong username or password");
});

test("an admin asks for another account's timeline with userId", async () => {
  const fetchMock = respond(200, []);
  (global as any).fetch = fetchMock;
  await fetchTimelineDays(auth, "Dev", 7);
  expect(fetchMock.mock.calls[0][0]).toContain("/api/timeline/days?deviceId=Dev&userId=7&tz=");
  await fetchTimelineDays(auth, "Dev");
  expect(fetchMock.mock.calls[1][0]).not.toContain("userId");
});

test("an unreachable server is an ApiError with status 0", async () => {
  (global as any).fetch = jest.fn().mockRejectedValue(new TypeError("Network request failed"));
  const error = await loginRequest("ws://x", { username: "a", password: "b", deviceId: "c" }).catch((e) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(0);
});

test("the timeline asks for one day of one device with the time zone offset", async () => {
  const fetchMock = respond(200, { date: "2025-06-10", segments: [] });
  (global as any).fetch = fetchMock;
  await fetchTimeline(auth, "Luis’ iPhone", "2025-06-10");
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toContain("http://10.0.0.2:3012/api/timeline?deviceId=Luis%E2%80%99%20iPhone&tz=");
  expect(init.headers.Authorization).toBe("Bearer t%2Fk%2B1");
});

test("a password change sends both passwords with the device headers and returns the new token", async () => {
  const fetchMock = respond(200, { message: "ok", token: "fresh" });
  (global as any).fetch = fetchMock;
  const { changePasswordRequest } = require("../lib/api");
  await expect(changePasswordRequest(auth, "old", "newpassword")).resolves.toMatchObject({ token: "fresh" });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/me/password");
  expect(JSON.parse(init.body)).toEqual({ currentPassword: "old", newPassword: "newpassword" });
  expect(init.headers.Authorization).toBe("Bearer t%2Fk%2B1");
});

test("asking a device for a position posts its id and tells whether it was reached", async () => {
  const fetchMock = respond(200, { message: "Location request sent to Pixel", devices: [] });
  (global as any).fetch = fetchMock;
  await expect(pingDeviceRequest(auth, "Pixel", 7)).resolves.toBe(true);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/sendPing");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ deviceId: "Pixel", userId: 7 });
});

test("saving a spot as Home sends the kind and leaves the name to the server", async () => {
  const fetchMock = respond(200, { id: 3 });
  (global as any).fetch = fetchMock;
  await savePlaceAt(auth, { lat: 49.79, lon: 9.95, kind: "home" }, 7);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/places?userId=7");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ lat: 49.79, lon: 9.95, kind: "home" });
});

test("a 202 means no device was reachable, a 404 names the device", async () => {
  (global as any).fetch = respond(202, { message: "No devices connected" });
  await expect(pingDeviceRequest(auth, "Pixel", 7)).resolves.toBe(false);
  (global as any).fetch = respond(404, { title: "device-not-connected", detail: "Device Pixel is not connected" });
  await expect(pingDeviceRequest(auth, "Pixel", 7)).rejects.toMatchObject({ status: 404 });
});

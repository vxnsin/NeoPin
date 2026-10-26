import { ApiError, deviceHeaders, fetchTimeline, loginRequest, normalizeServerUrl, registerRequest } from "../lib/api";

const auth = { serverIp: "ws://10.0.0.2:3012", deviceId: "Luis’ iPhone", token: "t/k+1" };

afterEach(() => {
  (global as any).fetch = undefined;
});

const respond = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

test("addresses without a scheme become ws://", () => {
  expect(normalizeServerUrl(" 192.168.1.20:3012 ")).toBe("ws://192.168.1.20:3012");
  expect(normalizeServerUrl("wss://pin.example.com")).toBe("wss://pin.example.com");
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

test("the server message is shown", async () => {
  (global as any).fetch = respond(400, { message: "Password needs 8 characters" });
  await expect(registerRequest("ws://x", { username: "luis", password: "1" })).rejects.toThrow("Password needs 8 characters");
  (global as any).fetch = respond(409, {});
  await expect(registerRequest("ws://x", { username: "luis", password: "1" })).rejects.toMatchObject({ status: 409 });
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
  expect(url).toContain("http://10.0.0.2:3012/api/timeline?deviceId=Luis%E2%80%99%20iPhone&date=2025-06-10&tz=");
  expect(init.headers.Authorization).toBe("Bearer t%2Fk%2B1");
});

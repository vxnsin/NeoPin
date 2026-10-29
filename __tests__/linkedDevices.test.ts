import { fetchLinkedDevices, unlinkDevice } from "../lib/api";

const auth = { serverIp: "wss://neopin.example.org", deviceId: "Pixel 8", token: "tok" };

afterEach(() => {
  (global as any).fetch = undefined;
});

const respond = (status: number, body?: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

test("my devices come from GET /api/devices with the device headers", async () => {
  const list = [{ deviceId: "Old iPad", linkedAt: "2026-01-01T00:00:00.000Z", deviceType: "tablet", primary: false, status: "offline", lastPing: null }];
  const fetchMock = respond(200, list);
  (global as any).fetch = fetchMock;
  expect(await fetchLinkedDevices(auth)).toEqual(list);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://neopin.example.org/api/devices");
  expect(init.headers.Authorization).toBe("Bearer tok");
});

test("unlinking is a DELETE with the name encoded", async () => {
  const fetchMock = respond(204);
  (global as any).fetch = fetchMock;
  await unlinkDevice(auth, "Luis’ iPad");
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://neopin.example.org/api/devices/Luis%E2%80%99%20iPad");
  expect(init.method).toBe("DELETE");
});

test("an unknown device shows the server text", async () => {
  (global as any).fetch = respond(404, { detail: "No such linked device" });
  await expect(unlinkDevice(auth, "Gone")).rejects.toThrow("No such linked device");
});

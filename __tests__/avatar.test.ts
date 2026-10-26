import { base64ToBytes, deviceHeaders, fetchAvatar, httpBase, uploadAvatar } from "../lib/avatar";
import { avatarColor, freshness, initials } from "../lib/devices";
import { buildMapHtml } from "../lib/mapHtml";

jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-image-manipulator", () => ({ ImageManipulator: { manipulate: jest.fn() }, SaveFormat: { JPEG: "jpeg" } }));

const creds = { serverIp: "ws://192.168.1.20:3012", deviceId: "Luis’ iPhone", password: "secret %1" };

afterEach(() => {
  (global as any).fetch = undefined;
});

test("the HTTP address follows the socket address", () => {
  expect(httpBase("ws://192.168.1.20:3012")).toBe("http://192.168.1.20:3012");
  expect(httpBase("wss://pin.example.com/")).toBe("https://pin.example.com");
  expect(httpBase(" WSS://pin.example.com/neopin/ ")).toBe("https://pin.example.com/neopin");
});

test("device headers stay ASCII for names and passwords outside it", () => {
  const headers = deviceHeaders(creds);
  expect(headers["X-Device-Id"]).toBe("Luis%E2%80%99%20iPhone");
  expect(headers.Authorization).toBe("Bearer secret%20%251");
  expect(Object.values(headers).join("")).toMatch(/^[\x20-\x7e]*$/);
  expect(decodeURIComponent(headers["X-Device-Id"])).toBe(creds.deviceId);
});

test("base64 decodes to the same bytes as Node's decoder", () => {
  const bytes = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256));
  for (const length of [0, 1, 2, 3, 299, 300]) {
    const slice = bytes.subarray(0, length);
    expect(Buffer.from(base64ToBytes(slice.toString("base64")))).toEqual(slice);
  }
});

test("an upload sends the JPEG with the device headers and returns the new URL", async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ avatarUrl: "/avatars/x?v=1" }) });
  (global as any).fetch = fetchMock;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

  await expect(uploadAvatar(creds, jpeg)).resolves.toBe("/avatars/x?v=1");

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://192.168.1.20:3012/api/avatar");
  expect(init.method).toBe("PUT");
  expect(init.body).toBe(jpeg);
  expect(init.headers["Content-Type"]).toBe("image/jpeg");
  expect(init.headers["X-Device-Id"]).toBe(encodeURIComponent(creds.deviceId));
});

test("a refused upload explains itself", async () => {
  (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
  await expect(uploadAvatar(creds, new Uint8Array(4))).rejects.toThrow("did not accept the password");
});

// Like React Native's FileReader, which does not know the blob's type either.
class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  async readAsDataURL(blob: Blob) {
    this.result = `data:application/octet-stream;base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
    this.onload?.();
  }
}

test("a loaded picture becomes a data URI with the type the server named", async () => {
  (global as any).FileReader = FakeFileReader;
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    headers: { get: () => "image/jpeg" },
    blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
  });
  const uri = await fetchAvatar(creds, "/avatars/Luis?v=1");
  expect(uri).toMatch(/^data:image\/jpeg;base64,AQID$/);
  expect((global as any).fetch.mock.calls[0][0]).toBe("http://192.168.1.20:3012/avatars/Luis?v=1");
});

test("status, initials and colours match the dashboard", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const base = { deviceId: "a", position: null, avatarUrl: null };
  expect(freshness({ ...base, status: "online", lastPing: "2026-10-26T11:58:00Z" }, now)).toBe("online");
  expect(freshness({ ...base, status: "online", lastPing: "2026-10-26T11:40:00Z" }, now)).toBe("stale");
  expect(freshness({ ...base, status: "online", lastPing: null }, now)).toBe("online");
  expect(freshness({ ...base, status: "offline", lastPing: "2026-10-26T11:59:00Z" }, now)).toBe("offline");

  expect(initials("Luis iPhone")).toBe("LI");
  expect(initials("pixel")).toBe("PI");
  expect(initials("  ")).toBe("?");
  expect(avatarColor("Luis iPhone")).toBe(avatarColor("Luis iPhone"));
  expect(avatarColor("Luis iPhone")).not.toMatch(/#16a34a|#eab308/);
});

test("the map page loads MapLibre with OpenFreeMap and escapes device names", () => {
  const html = buildMapHtml(true);
  expect(html).toContain("maplibre-gl@5.6.0");
  expect(html).toContain("https://tiles.openfreemap.org/styles/dark");
  expect(html).not.toContain("arcgisonline");
  expect(html).toContain("function esc(");
  expect(html).toContain('var dark = true;');
});

test("names show from zoom 14 and the map controls sit above the device bar", () => {
  const html = buildMapHtml(false, 34);
  expect(html).toContain('classList.toggle("show-labels", map.getZoom() >= 14)');
  expect(html).toContain("margin-bottom: 130px");
});

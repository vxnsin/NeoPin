import { fetchPlaces, getAlerts, setAlerts } from "../lib/api";

const auth = { serverIp: "ws://10.0.0.2:3012", deviceId: "Pixel", token: "tok" };

afterEach(() => {
  (global as any).fetch = undefined;
});

const respond = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

const settings = { places: [3, 4], recipients: { users: [7], groups: [2] } };

test("the alert setting is read with the device headers", async () => {
  const fetchMock = respond(200, settings);
  (global as any).fetch = fetchMock;
  await expect(getAlerts(auth)).resolves.toEqual(settings);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/alerts");
  expect(init.method).toBe("GET");
  expect(init.headers.Authorization).toBe("Bearer tok");
});

test("a server without arrival alerts answers 404, which reads as null", async () => {
  (global as any).fetch = respond(404, { title: "not-found" });
  await expect(getAlerts(auth)).resolves.toBeNull();
  (global as any).fetch = respond(500, { detail: "Broken" });
  await expect(getAlerts(auth)).rejects.toThrow("Broken");
});

test("saving puts the whole setting as JSON", async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error("no body"); } });
  (global as any).fetch = fetchMock;
  await expect(setAlerts(auth, settings)).resolves.toBeUndefined();
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/alerts");
  expect(init.method).toBe("PUT");
  expect(init.headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(init.body)).toEqual({ places: [3, 4], recipients: { users: [7], groups: [2] } });
  (global as any).fetch = respond(400, { detail: "Unknown person" });
  await expect(setAlerts(auth, settings)).rejects.toMatchObject({ status: 400, message: "Unknown person" });
});

test("the own places come from the places list", async () => {
  const fetchMock = respond(200, [{ id: 3, name: "Home", kind: "home", lat: 1, lon: 2, radiusM: 80, osmId: null }]);
  (global as any).fetch = fetchMock;
  await expect(fetchPlaces(auth)).resolves.toHaveLength(1);
  expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.2:3012/api/places");
});

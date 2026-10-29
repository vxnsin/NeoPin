import { fetchReview, getReviewNotifications, setReviewNotifications } from "../lib/api";

const auth = { serverIp: "ws://10.0.0.2:3012", deviceId: "Pixel", token: "tok" };

afterEach(() => {
  (global as any).fetch = undefined;
});

const respond = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

test("the review is asked for with the period, the day and the phone's time zone", async () => {
  const fetchMock = respond(200, { period: "week" });
  (global as any).fetch = fetchMock;
  await expect(fetchReview(auth, "week", "2026-10-19")).resolves.toEqual({ period: "week" });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(`http://10.0.0.2:3012/api/review?period=week&date=2026-10-19&tz=${new Date().getTimezoneOffset()}`);
  expect(init.method).toBe("GET");
  expect(init.headers.Authorization).toBe("Bearer tok");
  // Without a day the server takes the last finished period.
  await fetchReview(auth, "month");
  expect(fetchMock.mock.calls[1][0]).toBe(`http://10.0.0.2:3012/api/review?period=month&tz=${new Date().getTimezoneOffset()}`);
});

test("a server without reviews answers 404, which reads as null; other errors stay errors", async () => {
  (global as any).fetch = respond(404, { title: "not-found" });
  await expect(fetchReview(auth, "week")).resolves.toBeNull();
  await expect(getReviewNotifications(auth)).resolves.toBeNull();
  (global as any).fetch = respond(500, { detail: "Broken" });
  await expect(fetchReview(auth, "week")).rejects.toThrow("Broken");
  await expect(getReviewNotifications(auth)).rejects.toThrow("Broken");
});

test("the notification setting is on unless the server says it is off", async () => {
  (global as any).fetch = respond(200, { enabled: true });
  await expect(getReviewNotifications(auth)).resolves.toBe(true);
  (global as any).fetch = respond(200, { enabled: false });
  await expect(getReviewNotifications(auth)).resolves.toBe(false);
  (global as any).fetch = respond(200, {});
  await expect(getReviewNotifications(auth)).resolves.toBe(true);
});

test("switching it puts {enabled} as JSON", async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error("no body"); } });
  (global as any).fetch = fetchMock;
  await expect(setReviewNotifications(auth, false)).resolves.toBeUndefined();
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/me/review-notifications");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({ enabled: false });
  (global as any).fetch = respond(400, { detail: "Nope" });
  await expect(setReviewNotifications(auth, true)).rejects.toThrow("Nope");
});

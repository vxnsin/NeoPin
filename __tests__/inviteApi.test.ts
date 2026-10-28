import {
  checkInviteCode,
  createInviteCode,
  fetchNotifications,
  markNotificationsRead,
  registerRequest,
  revokeInviteCode,
} from "../lib/api";

const auth = { serverIp: "ws://10.0.0.2:3012", deviceId: "iPhone", token: "tok" };

afterEach(() => {
  (global as any).fetch = undefined;
});

const respond = (status: number, body?: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

test("creating a code posts group and note with the device headers", async () => {
  const fetchMock = respond(201, { id: 1, code: "ABCDE-12345" });
  (global as any).fetch = fetchMock;
  const code = await createInviteCode(auth, { groupId: 3, note: "Ben" });
  expect(code.code).toBe("ABCDE-12345");
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/invite-codes");
  expect(init.method).toBe("POST");
  expect(init.headers.Authorization).toBe("Bearer tok");
  expect(JSON.parse(init.body)).toEqual({ groupId: 3, note: "Ben" });
});

test("too many open codes shows the server text", async () => {
  (global as any).fetch = respond(429, { detail: "Too many open codes" });
  await expect(createInviteCode(auth, {})).rejects.toThrow("Too many open codes");
});

test("revoking a code is a DELETE", async () => {
  const fetchMock = respond(204);
  (global as any).fetch = fetchMock;
  await revokeInviteCode(auth, 7);
  expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.2:3012/api/invite-codes/7");
  expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
});

test("checking a code needs no login", async () => {
  const fetchMock = respond(200, { valid: true, invitedBy: "Anna", groupName: null });
  (global as any).fetch = fetchMock;
  const result = await checkInviteCode("ws://10.0.0.2:3012", "ABCDE12345");
  expect(result.valid).toBe(true);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/invite-codes/check");
  expect(init.headers.Authorization).toBeUndefined();
  expect(JSON.parse(init.body)).toEqual({ code: "ABCDE12345" });
});

test("registering posts the account and surfaces the problems", async () => {
  const fetchMock = respond(201, { id: 9 });
  (global as any).fetch = fetchMock;
  await registerRequest("ws://x:1", { code: "ABCDE12345", username: "ben", password: "longenough" });
  expect(fetchMock.mock.calls[0][0]).toBe("http://x:1/api/register");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: "ABCDE12345", username: "ben", password: "longenough" });

  (global as any).fetch = respond(409, { detail: "That username is taken" });
  await expect(registerRequest("ws://x:1", { code: "A", username: "ben", password: "p" })).rejects.toThrow("That username is taken");
  (global as any).fetch = respond(404, { detail: "This invite code is not valid" });
  await expect(registerRequest("ws://x:1", { code: "A", username: "ben", password: "p" })).rejects.toThrow("not valid");
});

test("notifications are read and marked", async () => {
  const fetchMock = respond(200, [{ id: 1 }]);
  (global as any).fetch = fetchMock;
  expect(await fetchNotifications(auth)).toEqual([{ id: 1 }]);
  expect(fetchMock.mock.calls[0][0]).toBe("http://10.0.0.2:3012/api/notifications");

  const mark = respond(204);
  (global as any).fetch = mark;
  await markNotificationsRead(auth, [1, 2]);
  expect(mark.mock.calls[0][0]).toBe("http://10.0.0.2:3012/api/notifications/read");
  expect(JSON.parse(mark.mock.calls[0][1].body)).toEqual({ ids: [1, 2] });
  await markNotificationsRead(auth);
  expect(JSON.parse(mark.mock.calls[1][1].body)).toEqual({});
});

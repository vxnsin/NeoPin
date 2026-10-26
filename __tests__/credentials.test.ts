jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import { parseSession } from "../lib/credentials";

const user = { id: 1, username: "luis", displayName: "Luis", avatarUrl: null };
const session = { serverIp: "ws://192.168.1.20:3012", deviceId: "iPhone", token: "abc", user };

test("a stored session is read back", () => {
  expect(parseSession(JSON.stringify(session))).toEqual(session);
});

test("the old password-style record is no session", () => {
  const legacy = { serverIp: "ws://192.168.1.20:3012", deviceId: "iPhone", password: "neopin123" };
  expect(parseSession(JSON.stringify(legacy))).toBeNull();
  expect(parseSession(JSON.stringify({ ...session, password: "x" }))).toBeNull();
});

test("broken records do not throw", () => {
  expect(parseSession(null)).toBeNull();
  expect(parseSession("")).toBeNull();
  expect(parseSession("{not json")).toBeNull();
  expect(parseSession("null")).toBeNull();
  expect(parseSession(JSON.stringify({ ...session, token: "" }))).toBeNull();
  expect(parseSession(JSON.stringify({ ...session, user: undefined }))).toBeNull();
});

test("missing display name or picture fall back", () => {
  const parsed = parseSession(JSON.stringify({ ...session, user: { id: 2, username: "anna" } }));
  expect(parsed?.user).toEqual({ id: 2, username: "anna", displayName: "anna", avatarUrl: null });
});

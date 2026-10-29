import { createDedupe, dataOf, needsRegistration, parsePushAction } from "../lib/pushPayload";

const wake = { type: "requestLocation", from: "Anna", id: "abc" };

test("android task payload carries the FCM data flat", () => {
  const payload = { data: { ...wake, dataString: null }, notification: null };
  expect(parsePushAction(payload)).toEqual({ type: "requestLocation", from: "Anna", id: "abc" });
});

test("a JSON string in dataString is read as well", () => {
  expect(parsePushAction({ data: { dataString: JSON.stringify(wake) }, notification: null })).toEqual({
    type: "requestLocation",
    from: "Anna",
    id: "abc",
  });
  expect(parsePushAction({ data: { body: JSON.stringify({ type: "groupInvite" }) } })).toEqual({ type: "groupInvite" });
});

test("a notification response and a received notification are read from the request content", () => {
  const response = {
    actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
    notification: { request: { content: { data: { type: "groupInvite" } } } },
  };
  expect(parsePushAction(response)).toEqual({ type: "groupInvite" });
  expect(parsePushAction({ request: { content: { data: wake } } })).toEqual({
    type: "requestLocation",
    from: "Anna",
    id: "abc",
  });
  expect(parsePushAction({ request: { content: { dataString: '{"type":"groupInvite"}' } } })).toEqual({
    type: "groupInvite",
  });
});

test("a task payload that wraps the content of a tapped notification works", () => {
  const payload = { notification: { request: { content: { data: { type: "groupInvite" } } } }, actionIdentifier: "x" };
  expect(parsePushAction(payload)).toEqual({ type: "groupInvite" });
});

test("a wake-up without name or id still works", () => {
  expect(parsePushAction({ data: { type: "requestLocation" } })).toEqual({
    type: "requestLocation",
    from: "",
    id: null,
  });
});

test("unknown or broken payloads are ignored", () => {
  expect(parsePushAction(null)).toBeNull();
  expect(parsePushAction("x")).toBeNull();
  expect(parsePushAction({ data: { type: "other" } })).toBeNull();
  expect(parsePushAction({ data: { dataString: "{nope" } })).toBeNull();
  expect(parsePushAction({ data: {}, notification: null })).toBeNull();
});

const current = { token: "t1", serverIp: "ws://a", deviceId: "d", auth: "k" };

test("a token is registered once per token, server and login", () => {
  expect(needsRegistration(null, current)).toBe(true);
  expect(needsRegistration(current, { ...current })).toBe(false);
  expect(needsRegistration(current, { ...current, token: "t2" })).toBe(true);
  expect(needsRegistration(current, { ...current, auth: "k2" })).toBe(true);
  expect(needsRegistration(current, { ...current, serverIp: "ws://b" })).toBe(true);
});

test("a wake-up id is only let through once", () => {
  const fresh = createDedupe(2);
  expect(fresh("a")).toBe(true);
  expect(fresh("a")).toBe(false);
  expect(fresh(null)).toBe(true);
  fresh("b");
  fresh("c");
  expect(fresh("a")).toBe(true);
});

test("a find request push is parsed in every payload shape", () => {
  const data = { type: "findRequest", session: "s1", from: "Anna" };
  const expected = { type: "findRequest", session: "s1", from: "Anna" };
  expect(parsePushAction({ data, notification: null })).toEqual(expected);
  expect(parsePushAction({ data: { dataString: JSON.stringify(data) } })).toEqual(expected);
  expect(parsePushAction({ notification: { request: { content: { data } } }, actionIdentifier: "x" })).toEqual(expected);
  expect(parsePushAction({ request: { content: { data } } })).toEqual(expected);
  expect(parsePushAction({ data: { type: "findRequest" } })).toEqual({ type: "findRequest", session: "", from: "" });
});

test("an arrival or a departure push names the person", () => {
  expect(parsePushAction({ data: { type: "arrived", userId: "4", placeId: "3" } })).toEqual({ type: "placeAlert", userId: 4 });
  expect(parsePushAction({ notification: { request: { content: { data: { type: "left" } } } } })).toEqual({
    type: "placeAlert",
    userId: null,
  });
});

test("a used invite code is recognised in every payload shape", () => {
  expect(parsePushAction({ data: { type: "inviteUsed" } })).toEqual({ type: "inviteUsed" });
  expect(parsePushAction({ notification: { request: { content: { data: { type: "inviteUsed" } } } } })).toEqual({
    type: "inviteUsed",
  });
});

test("the data of a push is found with the short type key too", () => {
  const data = { t: "rideQuestion", rideId: "r1" };
  expect(dataOf({ data, notification: null })).toEqual(data);
  expect(dataOf({ request: { content: { dataString: JSON.stringify(data) } } })).toEqual(data);
  // Other kinds keep their meaning: a message with only `t` is nothing parsePushAction knows.
  expect(parsePushAction({ data })).toBeNull();
});

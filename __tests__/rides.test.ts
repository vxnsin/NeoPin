jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("expo-notifications", () => ({
  setNotificationCategoryAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn().mockResolvedValue("id"),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/credentials", () => ({
  readCredentials: jest.fn().mockResolvedValue({ serverIp: "ws://10.0.0.2:3012", deviceId: "Pixel", token: "tok" }),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { answerRide } from "../lib/api";
import { dataOf } from "../lib/pushPayload";
import * as Notifications from "expo-notifications";
import { answerOnce, firstAsk, offerRide, onRide, showRide, takeRide, wasAnswered } from "../lib/rideInbox";
import { sendRideAnswer } from "../lib/ridePush";
import {
  RIDE_NO,
  RIDE_MAX_AGE_MS,
  RIDE_YES,
  isStaleRide,
  parseRideQuestion,
  readableOn,
  rememberOnce,
  rideAnswerOf,
  rideQuestionDetail,
  rideQuestionText,
  rideResponseOf,
  stampRide,
} from "../lib/rides";

const transit = { kind: "bus", line: "10", headsign: "Hauptbahnhof", color: "#d3171e", from: "Sanderring" };
const socketMessage = { type: "rideQuestion", rideId: "Pixel:1761750000000", transit, at: 1761750000000 };

const expected = {
  rideId: "Pixel:1761750000000",
  transit: { kind: "bus", line: "10", headsign: "Hauptbahnhof", color: "#d3171e", textColor: "#ffffff", from: "Sanderring" },
  at: 1761750000000,
};

beforeEach(() => AsyncStorage.clear());

afterEach(() => {
  (global as any).fetch = undefined;
});

test("the socket message is read as it comes", () => {
  expect(parseRideQuestion(socketMessage)).toEqual(expected);
});

test("an FCM data message has strings only: the short type key and the transit as JSON", () => {
  const data = { t: "rideQuestion", rideId: "Pixel:1761750000000", transit: JSON.stringify(transit), at: "1761750000000" };
  expect(parseRideQuestion(dataOf({ data, notification: null }))).toEqual(expected);
  // The transit fields may also sit flat beside the rest, colours without the "#".
  const flat = { t: "rideQuestion", rideId: "r1", kind: "train", line: "RB 53", headsign: "Gemünden", color: "ffcc00", from: "Würzburg Hbf" };
  expect(parseRideQuestion(dataOf({ data: flat }))).toMatchObject({
    rideId: "r1",
    transit: { kind: "train", line: "RB 53", color: "#ffcc00", textColor: "#000000", from: "Würzburg Hbf" },
    at: null,
  });
});

test("a stop given as an object, a number as the ride id, a kind the app does not know", () => {
  const question = parseRideQuestion({ type: "rideQuestion", rideId: 42, transit: { kind: "cablecar", line: 7, headsign: null, color: null, from: { name: "Talstation" } } });
  expect(question).toEqual({ rideId: "42", transit: { kind: null, line: "7", headsign: null, color: null, textColor: null, from: "Talstation" }, at: null });
});

test("anything without a ride or a line, or of another type, is no question", () => {
  expect(parseRideQuestion({ ...socketMessage, rideId: "" })).toBeNull();
  expect(parseRideQuestion({ ...socketMessage, transit: { ...transit, line: "" } })).toBeNull();
  expect(parseRideQuestion({ ...socketMessage, transit: "{broken" })).toBeNull();
  expect(parseRideQuestion({ ...socketMessage, type: "findRequest" })).toBeNull();
  expect(parseRideQuestion(null)).toBeNull();
});

test("the question names the line the way people say it", () => {
  expect(rideQuestionText(parseRideQuestion(socketMessage)!)).toBe("Are you on Bus 10 towards Hauptbahnhof?");
  const rb = parseRideQuestion({ ...socketMessage, transit: { kind: "train", line: "RB 53", headsign: "Gemünden" } })!;
  expect(rideQuestionText(rb)).toBe("Are you on RB 53 towards Gemünden?");
  const tram = parseRideQuestion({ ...socketMessage, transit: { kind: "tram", line: "5" } })!;
  expect(rideQuestionText(tram)).toBe("Are you on Tram 5?");
  expect(rideQuestionDetail(parseRideQuestion(socketMessage)!)).toBe("Since Sanderring");
  expect(rideQuestionDetail(tram)).toBe("Your answer puts the line on your timeline.");
});

test("the badge text is white or black, whichever reads on the line's colour", () => {
  expect(readableOn("#000080")).toBe("#ffffff");
  expect(readableOn("#ffee00")).toBe("#000000");
});

test("the notification buttons map to the answers, a plain tap to none", () => {
  expect(rideAnswerOf(RIDE_YES)).toBe("yes");
  expect(rideAnswerOf(RIDE_NO)).toBe("no");
  expect(rideAnswerOf("expo.modules.notifications.actions.DEFAULT")).toBeNull();
});

test("a button on the notification brings the question back from its data", () => {
  // The background task gets the content's data as a JSON string, the app's listener as an object.
  const local = { type: "rideQuestion", rideId: "r1", transit: expected.transit, at: null };
  const fromTask = { actionIdentifier: RIDE_YES, notification: { request: { identifier: "ride.r1", content: { dataString: JSON.stringify(local) } } } };
  expect(rideResponseOf(fromTask)).toMatchObject({ answer: "yes", question: { rideId: "r1", transit: { line: "10" } } });
  const fromListener = { actionIdentifier: "expo.modules.notifications.actions.DEFAULT", notification: { request: { content: { data: local } } } };
  expect(rideResponseOf(fromListener)).toMatchObject({ answer: null, question: { rideId: "r1" } });
  // A received notification has no action, other notifications are not rides.
  expect(rideResponseOf({ request: { content: { data: local } } })).toBeNull();
  expect(rideResponseOf({ actionIdentifier: RIDE_NO, notification: { request: { content: { data: { type: "groupInvite" } } } } })).toBeNull();
});

test("a ride id is new once, and the list stays short", () => {
  let seen: string[] = [];
  ({ seen } = rememberOnce(seen, "a"));
  expect(rememberOnce(seen, "a").fresh).toBe(false);
  const next = rememberOnce(["a", "b", "c"], "d", 3);
  expect(next).toEqual({ fresh: true, seen: ["b", "c", "d"] });
});

test("each ride is asked once, also when the socket and the push both bring it", async () => {
  const shown: string[] = [];
  const off = onRide((question) => shown.push(question.rideId));
  const question = parseRideQuestion(socketMessage)!;
  await Promise.all([offerRide(question), offerRide(question)]);
  await offerRide(question);
  expect(shown).toEqual(["Pixel:1761750000000"]);
  expect(typeof takeRide()?.seenAt).toBe("number");
  expect(takeRide()).toBeNull();
  off();
  // A later run (the background task, a restart) still knows it from storage.
  expect(JSON.parse((await AsyncStorage.getItem("neopin.ridesAsked"))!)).toEqual(["Pixel:1761750000000"]);
  expect(await firstAsk("another")).toBe(true);
});

test("a question is too old 15 minutes after it reached the app, or after the ride began without that", () => {
  const question = parseRideQuestion(socketMessage)!;
  const seen = stampRide(question, 1_000_000);
  expect(stampRide(seen, 2_000_000).seenAt).toBe(1_000_000);
  expect(isStaleRide(seen, 1_000_000 + RIDE_MAX_AGE_MS)).toBe(false);
  expect(isStaleRide(seen, 1_000_001 + RIDE_MAX_AGE_MS)).toBe(true);
  expect(isStaleRide(question, question.at! + RIDE_MAX_AGE_MS + 1)).toBe(true);
  expect(isStaleRide({ ...question, at: null }, Date.now())).toBe(false);
  // The age comes back from the notification's data.
  expect(parseRideQuestion({ ...socketMessage, seenAt: "1000000" })?.seenAt).toBe(1_000_000);
});

test("an old question is neither offered nor taken", async () => {
  const shown: string[] = [];
  const off = onRide((question) => shown.push(question.rideId));
  const old = parseRideQuestion({ ...socketMessage, rideId: "old" })!;
  // It reached the app long ago (it comes back from a notification with its seenAt).
  await offerRide(stampRide(old, 0), RIDE_MAX_AGE_MS + 1);
  expect(shown).toEqual([]);
  showRide(stampRide(old, 0));
  off();
  expect(takeRide(RIDE_MAX_AGE_MS + 1)).toBeNull();
  showRide(stampRide(old, 0));
  expect(takeRide(RIDE_MAX_AGE_MS)?.rideId).toBe("old");
});

test("the same answer twice goes out once, another one after it, and none reports early", async () => {
  let release: () => void = () => {};
  const first = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
  const again = jest.fn(async () => {});
  const other = jest.fn(async () => {});
  const a = answerOnce("r1", "yes", first);
  const b = answerOnce("r1", "yes", again);
  const c = answerOnce("r1", "no", other);
  let settled = false;
  b.then(() => (settled = true));
  await Promise.resolve();
  expect(first).toHaveBeenCalledTimes(1);
  expect(again).not.toHaveBeenCalled();
  expect(other).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  release();
  await Promise.all([a, b, c]);
  expect(other).toHaveBeenCalledTimes(1);
  // Once nothing is on its way, the answer can be given (and changed) again.
  const later = jest.fn(async () => {});
  await answerOnce("r1", "yes", later);
  expect(later).toHaveBeenCalledTimes(1);
});

test("a failed answer throws and can be given again, a ride the server no longer knows just goes away", async () => {
  const question = parseRideQuestion(socketMessage)!;
  (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ detail: "Broken" }) });
  await expect(sendRideAnswer(question, "yes")).rejects.toThrow("Broken");
  expect(await wasAnswered(question.rideId)).toBe(false);
  (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ detail: "No such ride" }) });
  await expect(sendRideAnswer(question, "no")).resolves.toBeUndefined();
  expect(await wasAnswered(question.rideId)).toBe(true);
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith("ride.Pixel:1761750000000");
  // The answer may still be changed.
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
  (global as any).fetch = fetchMock;
  await sendRideAnswer(question, "yes");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ rideId: "Pixel:1761750000000", answer: "yes" });
});

test("the answer is posted with the ride id and expects no content", async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error("no body"); } });
  (global as any).fetch = fetchMock;
  const auth = { serverIp: "ws://10.0.0.2:3012", deviceId: "Pixel", token: "tok" };
  await expect(answerRide(auth, "Pixel:1761750000000", "yes")).resolves.toBeUndefined();
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://10.0.0.2:3012/api/rides/answer");
  expect(init.method).toBe("POST");
  expect(init.headers.Authorization).toBe("Bearer tok");
  expect(JSON.parse(init.body)).toEqual({ rideId: "Pixel:1761750000000", answer: "yes" });
  (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ detail: "No such ride" }) });
  await expect(answerRide(auth, "x", "no")).rejects.toThrow("No such ride");
});

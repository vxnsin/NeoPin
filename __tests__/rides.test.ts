jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { answerRide } from "../lib/api";
import { dataOf } from "../lib/pushPayload";
import { firstAnswer, firstAsk, forgetAnswer, offerRide, onRide, takeRide, wasAnswered } from "../lib/rideInbox";
import {
  RIDE_NO,
  RIDE_YES,
  parseRideQuestion,
  readableOn,
  rememberOnce,
  rideAnswerOf,
  rideQuestionDetail,
  rideQuestionText,
  rideResponseOf,
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
  expect(takeRide()?.rideId).toBe("Pixel:1761750000000");
  expect(takeRide()).toBeNull();
  off();
  // A later run (the background task, a restart) still knows it from storage.
  expect(JSON.parse((await AsyncStorage.getItem("neopin.ridesAsked"))!)).toEqual(["Pixel:1761750000000"]);
  expect(await firstAsk("another")).toBe(true);
});

test("an answer goes out once, a failed one can be given again", async () => {
  expect(await firstAnswer("r9")).toBe(true);
  expect(await firstAnswer("r9")).toBe(false);
  expect(await wasAnswered("r9")).toBe(true);
  await forgetAnswer("r9");
  expect(await wasAnswered("r9")).toBe(false);
  expect(await firstAnswer("r9")).toBe(true);
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

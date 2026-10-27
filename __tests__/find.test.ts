jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import { arrowAngle, bearingDeg, distanceBand, endedText, formatMeters, mapsUrls, reduceFind, type FindState } from "../lib/find";

const peer = { id: 2, username: "anna", displayName: "Anna", avatarUrl: null };
const me = { id: 1, username: "luis", displayName: "Luis", avatarUrl: null };

test("bearing points the way: north, east, and across the date line", () => {
  const home = { latitude: 49.79, longitude: 9.95 };
  expect(Math.round(bearingDeg(home, { latitude: 49.8, longitude: 9.95 }))).toBe(0);
  expect(Math.round(bearingDeg(home, { latitude: 49.79, longitude: 9.96 }))).toBe(90);
  expect(Math.round(bearingDeg(home, { latitude: 49.78, longitude: 9.95 }))).toBe(180);
  expect(Math.round(bearingDeg({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 }))).toBe(90);
});

test("the arrow turns relative to where the phone points, the short way round", () => {
  expect(arrowAngle(90, 0)).toBe(90);
  expect(arrowAngle(0, 90)).toBe(-90);
  expect(arrowAngle(350, 10)).toBe(-20);
  expect(arrowAngle(10, 350)).toBe(20);
  expect(arrowAngle(180, 0)).toBe(-180);
});

test("metres read like a person would say them", () => {
  expect(formatMeters(4.4)).toBe("4 m");
  expect(formatMeters(423)).toBe("425 m");
  expect(formatMeters(1234)).toBe("1.2 km");
  expect(formatMeters(12_600)).toBe("13 km");
  expect(distanceBand(400)).toBe("far");
  expect(distanceBand(80)).toBe("near");
  expect(distanceBand(12)).toBe("close");
});

test("maps links: Apple Maps on iOS, Google navigation first on Android, walking both", () => {
  expect(mapsUrls("ios", 49.79, 9.95)[0]).toBe("maps://?daddr=49.790000,9.950000&dirflg=w");
  const android = mapsUrls("android", 49.79, 9.95);
  expect(android[0]).toBe("google.navigation:q=49.790000,9.950000&mode=w");
  expect(android[1]).toMatch(/^geo:/);
});

test("the server's messages move a search along", () => {
  let state: FindState | null = null;
  state = reduceFind(state, { type: "findPending", session: "s1", peer, expiresAt: 10 });
  expect(state).toMatchObject({ phase: "pending", session: "s1" });
  // While I search, a request from somebody else does not get through.
  expect(reduceFind(state, { type: "findRequest", session: "s9", from: me, expiresAt: 5 })).toBe(state);
  state = reduceFind(state, { type: "findStarted", session: "s1", peer, expiresAt: 100 });
  expect(state).toMatchObject({ phase: "active", theirs: null });
  // A stray position for another session changes nothing.
  expect(reduceFind(state, { type: "findPosition", session: "s2", latitude: 1, longitude: 2, at: 3 })).toBe(state);
  state = reduceFind(state, { type: "findPosition", session: "s1", latitude: 49.79, longitude: 9.95, accuracy: 5, heading: null, at: 3 });
  expect(state).toMatchObject({ phase: "active", theirs: { latitude: 49.79, accuracy: 5, heading: null } });
  expect(reduceFind(state, { type: "findEnded", session: "s2", reason: "ended" })).toBe(state);
  state = reduceFind(state, { type: "findEnded", session: "s1", reason: "declined" });
  expect(state).toEqual({ phase: "ended", session: "s1", peer, reason: "declined" });
});

test("only the search in hand moves along, a start for another session is ignored", () => {
  const other = { id: 3, username: "tom", displayName: "Tom", avatarUrl: null };
  let state: FindState | null = { phase: "pending", session: "", peer, expiresAt: 1 };
  expect(reduceFind(state, { type: "findStarted", session: "s9", peer: other, expiresAt: 9 })).toBe(state);
  expect(reduceFind(state, { type: "findPending", session: "s9", peer: other, expiresAt: 9 })).toBe(state);
  state = reduceFind(state, { type: "findPending", session: "s1", peer, expiresAt: 10 });
  expect(state).toMatchObject({ phase: "pending", session: "s1" });
  expect(reduceFind(state, { type: "findStarted", session: "s2", peer, expiresAt: 9 })).toBe(state);
  expect(reduceFind(state, { type: "findStarted", session: "s1", peer, expiresAt: 99 })).toMatchObject({ phase: "active", session: "s1" });
  // Being asked: the start names the session of the question.
  const asked: FindState = { phase: "asked", session: "s3", peer: me, expiresAt: 9 };
  expect(reduceFind(asked, { type: "findStarted", session: "s3", peer: me, expiresAt: 99 })).toMatchObject({ phase: "active" });
  expect(reduceFind(null, { type: "findStarted", session: "s3", peer: me, expiresAt: 99 })).toBeNull();
});

test("a refused request ends with no session, and being asked opens the question", () => {
  const refused = reduceFind({ phase: "pending", session: "", peer, expiresAt: 1 }, { type: "findEnded", session: null, reason: "offline" });
  expect(refused).toMatchObject({ phase: "ended", reason: "offline", peer });
  const asked = reduceFind(null, { type: "findRequest", session: "s3", from: me, expiresAt: 9 });
  expect(asked).toEqual({ phase: "asked", session: "s3", peer: me, expiresAt: 9 });
  expect(endedText("offline", "Anna")).toBe("Anna has no phone online right now.");
  expect(endedText("timeout", null)).toBe("Time ran out.");
});

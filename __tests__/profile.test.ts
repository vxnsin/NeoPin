import { displayNameProblem, profileChanges, usernameProblem } from "../lib/profile";

test("usernames follow the server rules", () => {
  expect(usernameProblem("")).toBeDefined();
  expect(usernameProblem("ab")).toBeDefined();
  expect(usernameProblem("has space")).toBeDefined();
  expect(usernameProblem("x".repeat(33))).toBeDefined();
  expect(usernameProblem(" luis.k_1-x ")).toBeUndefined();
});

test("display names must not be empty or longer than 48", () => {
  expect(displayNameProblem("   ")).toBeDefined();
  expect(displayNameProblem("x".repeat(49))).toBeDefined();
  expect(displayNameProblem("Luis")).toBeUndefined();
  expect(displayNameProblem("x".repeat(48))).toBeUndefined();
});

test("only changed fields are sent", () => {
  const current = { displayName: "Luis", username: "luis" };
  expect(profileChanges(current, { displayName: " Luis ", username: "luis" })).toEqual({});
  expect(profileChanges(current, { displayName: "Lu", username: "luis" })).toEqual({ displayName: "Lu" });
  expect(profileChanges(current, { displayName: "Luis", username: "lk" })).toEqual({ username: "lk" });
});

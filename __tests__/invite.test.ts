import { checkLine, codeChip, codeFromLink, formatCode, hasProblems, inviteLink, isFullCode, normalizeCode, registerProblems, shareText } from "../lib/invite";

test("a code is normalised like the server does", () => {
  expect(normalizeCode(" abcde-12345 ")).toBe("ABCDE12345");
  expect(normalizeCode("abc de 123 45 extra")).toBe("ABCDE12345");
  expect(isFullCode("abcde 12345")).toBe(true);
  expect(isFullCode("abcde-1234")).toBe(false);
});

test("a code is shown with its dash", () => {
  expect(formatCode("abcde12345")).toBe("ABCDE-12345");
  expect(formatCode("abc")).toBe("ABC");
  expect(formatCode("abcde")).toBe("ABCDE");
  expect(formatCode("abcdef")).toBe("ABCDE-F");
});

test("the link and the share text carry the code", () => {
  expect(inviteLink("abcde12345")).toBe("neopin://invite?code=ABCDE-12345");
  expect(shareText("ABCDE-12345")).toBe(
    "Join me on NeoPin with this invite code: ABCDE-12345\nneopin://invite?code=ABCDE-12345"
  );
});

test("a deep link is read for its code", () => {
  expect(codeFromLink("neopin://invite?code=abcde-12345")).toBe("ABCDE12345");
  expect(codeFromLink("neopin:///invite?code=ABCDE%2D12345&x=1")).toBe("ABCDE12345");
  expect(codeFromLink("neopin://invite?x=1&code=ABCDE12345#top")).toBe("ABCDE12345");
  expect(codeFromLink("neopin://invite")).toBeNull();
  expect(codeFromLink("neopin://invite?code=")).toBeNull();
  expect(codeFromLink("neopin://map?code=ABCDE12345")).toBeNull();
  expect(codeFromLink(null)).toBeNull();
});

const form = { code: "ABCDE-12345", username: "anna", displayName: "", password: "longenough", confirm: "longenough" };

test("a complete form has no problems", () => {
  expect(hasProblems(registerProblems(form))).toBe(false);
});

test("the form is checked like the rest of the app", () => {
  expect(registerProblems({ ...form, code: "ABC" }).code).toBeDefined();
  expect(registerProblems({ ...form, username: "an" }).username).toBeDefined();
  expect(registerProblems({ ...form, username: "an na" }).username).toBeDefined();
  expect(registerProblems({ ...form, displayName: "x".repeat(49) }).displayName).toBeDefined();
  expect(registerProblems({ ...form, password: "short", confirm: "short" }).password).toBeDefined();
  expect(registerProblems({ ...form, confirm: "different1" }).confirm).toBeDefined();
});

test("the check result becomes a line", () => {
  expect(checkLine({ valid: false })).toBe("This invite code is not valid");
  expect(checkLine({ valid: true, invitedBy: "Anna", groupName: "Family" })).toBe("Invited by Anna · joins Family");
  expect(checkLine({ valid: true, invitedBy: "Anna", groupName: null })).toBe("Invited by Anna");
});

test("chips say what happened to a code", () => {
  const when = (iso: string) => `@${iso}`;
  const base = { expiresAt: "E", usedBy: null, usedAt: null };
  expect(codeChip({ ...base, status: "open" }, when)).toEqual({ label: "Open · until @E", tone: "open" });
  const user = { id: 2, username: "b", displayName: "Ben", avatarUrl: null };
  expect(codeChip({ ...base, status: "used", usedBy: user, usedAt: "U" }, when).label).toBe("Used by Ben · @U");
  expect(codeChip({ ...base, status: "expired" }, when).tone).toBe("gone");
  expect(codeChip({ ...base, status: "revoked" }, when).label).toBe("Revoked");
});

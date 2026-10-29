import { checkLine, codeChip, codeFromLink, formatCode, hasProblems, inviteLink, isFullCode, normalizeCode, registerProblems, serverFromLink, shareText, linkServerParams, inviteRedirect } from "../lib/invite";

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

test("the link is the server's invite page and the share text carries it", () => {
  expect(inviteLink("abcde12345", "wss://neopin.example.org")).toBe("https://neopin.example.org/invite/ABCDE-12345");
  expect(inviteLink("abcde12345", "ws://192.168.1.20:3012/")).toBe("http://192.168.1.20:3012/invite/ABCDE-12345");
  expect(shareText("ABCDE-12345", "wss://neopin.example.org")).toBe(
    "Join me on NeoPin with this invite code: ABCDE-12345\nhttps://neopin.example.org/invite/ABCDE-12345"
  );
});

test("the server of an invite link is taken as it came, anything else is dropped", () => {
  expect(serverFromLink("https://neopin.example.org/")).toBe("https://neopin.example.org");
  expect(serverFromLink(["http://192.168.1.20:3012"])).toBe("http://192.168.1.20:3012");
  expect(serverFromLink("javascript:alert(1)")).toBe("");
  expect(serverFromLink("neopin.example.org")).toBe("https://neopin.example.org");
  expect(serverFromLink("192.168.1.20:3012", "0")).toBe("http://192.168.1.20:3012");
  expect(serverFromLink("evil/path")).toBe("");
  expect(serverFromLink(undefined)).toBe("");
});

test("the server goes on inside the app without its scheme", () => {
  expect(linkServerParams("https://neopin.example.org/")).toEqual({ server: "neopin.example.org" });
  expect(linkServerParams("http://192.168.1.20:3012")).toEqual({ server: "192.168.1.20:3012", secure: "0" });
});

test("an incoming invite link is rewritten so the router finds the invite route", () => {
  expect(inviteRedirect("neopin:///invite?code=XJ7KZTJ8E4&server=https://neopin.labvault.xyz")).toBe(
    "neopin:///invite?code=XJ7KZTJ8E4&server=neopin.labvault.xyz"
  );
  expect(inviteRedirect("neopin://invite?code=xj7kz-tj8e4&server=http%3A%2F%2F192.168.1.20%3A3012")).toBe(
    "neopin:///invite?code=XJ7KZTJ8E4&server=192.168.1.20%3A3012&secure=0"
  );
  expect(inviteRedirect("neopin://invite?code=XJ7KZTJ8E4")).toBe("neopin:///invite?code=XJ7KZTJ8E4");
  expect(inviteRedirect("neopin://map")).toBeNull();
  expect(inviteRedirect("https://neopin.labvault.xyz/invite/XJ7KZ-TJ8E4")).toBeNull();
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

// Invite code helpers for the sign-up form. Plain functions without exports, so the page loads
// this as a script and the tests run the same file.

// Same reading as the server: any case, spaces and dashes ignored, O is 0, I and L are 1.
function normaliseInviteCode(input) {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

// What the field shows while typing: at most ten characters in two groups of five.
function formatInviteCode(input) {
  const code = normaliseInviteCode(input).slice(0, 10);
  return code.length > 5 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

const isCompleteInviteCode = (input) => normaliseInviteCode(input).length === 10;

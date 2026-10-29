import { DISPLAY_NAME_MAX, usernameProblem } from "@/lib/profile";
import { PASSWORD_MIN } from "@/lib/password";
import { httpBase, type InviteCode } from "@/lib/api";

export const CODE_LENGTH = 10;
export const INVITE_SCHEME = "neopin://invite";

// Case does not matter and neither do spaces or dashes, so a pasted code works however it was typed.
export function normalizeCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, CODE_LENGTH);
}

export function isFullCode(input: string): boolean {
  return normalizeCode(input).length === CODE_LENGTH;
}

// "abcde12345" -> "ABCDE-12345", a partial code gets its dash once there is something behind it.
export function formatCode(input: string): string {
  const code = normalizeCode(input);
  return code.length > 5 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

// The server's invite page: a link every messenger makes clickable, which opens the app with
// the code and the server, or the sign-up in the browser.
export function inviteLink(code: string, serverIp: string): string {
  return `${httpBase(serverIp)}/invite/${encodeURIComponent(formatCode(code))}`;
}

export function shareText(code: string, serverIp: string): string {
  return `Join me on NeoPin with this invite code: ${formatCode(code)}\n${inviteLink(code, serverIp)}`;
}

type Param = string | string[] | null | undefined;
const one = (value: Param) => (Array.isArray(value) ? value[0] : value ?? "").trim();

// The server a neopin://invite link came with, as the address field takes it, or "" without one.
// Links carry it without a scheme ("neopin.example.org", secure unless secure=0): a "://" inside
// the query made the router miss the invite route. Older links with a full address still work.
export function serverFromLink(value: Param, secure?: Param): string {
  const server = one(value);
  if (/^(https?|wss?):\/\/[^\s/]+/i.test(server)) return server.replace(/\/+$/, "");
  if (/^[a-z0-9.-]+(:\d{1,5})?$/i.test(server) && server.includes(".")) return `${one(secure) === "0" ? "http" : "https"}://${server}`;
  if (/^localhost(:\d{1,5})?$/i.test(server)) return `${one(secure) === "0" ? "http" : "https"}://${server}`;
  return "";
}

// The other way round, for handing the server on inside the app: no "://" in a route.
export function linkServerParams(server: string): { server: string; secure?: string } {
  const host = server.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
  return /^(http|ws):\/\//i.test(server) ? { server: host, secure: "0" } : { server: host };
}

// An incoming neopin://invite link in the form the router can take: the server without its
// scheme. Anything that is not an invite link is left alone (null).
export function inviteRedirect(url: string): string | null {
  const match = /^neopin:\/{2,3}invite\/?\?(.*)$/i.exec(url.trim());
  if (!match) return null;
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(match[1].split("#")[0]);
  } catch {
    return null;
  }
  const out = new URLSearchParams();
  const code = normalizeCode(query.get("code") ?? "");
  if (code) out.set("code", code);
  const server = serverFromLink(query.get("server"), query.get("secure"));
  if (server) {
    const params = linkServerParams(server);
    out.set("server", params.server);
    if (params.secure) out.set("secure", params.secure);
  }
  const rest = out.toString();
  return `neopin:///invite${rest ? `?${rest}` : ""}`;
}

// The code of a neopin://invite?code=... link, or null when the link is something else.
export function codeFromLink(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^neopin:\/\/\/?invite\/?\?(.*)$/i.exec(url.trim());
  if (!match) return null;
  for (const pair of match[1].split("#")[0].split("&")) {
    const [key, value = ""] = pair.split("=");
    if (key !== "code") continue;
    let decoded = value;
    try {
      decoded = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      // keep the raw value
    }
    const code = normalizeCode(decoded);
    return code ? code : null;
  }
  return null;
}

export type RegisterForm = {
  code: string;
  username: string;
  displayName: string;
  password: string;
  confirm: string;
};

export type RegisterErrors = { code?: string; username?: string; displayName?: string; password?: string; confirm?: string };

export function registerProblems(form: RegisterForm): RegisterErrors {
  const errors: RegisterErrors = {};
  if (!isFullCode(form.code)) errors.code = "Enter the full invite code.";
  const username = usernameProblem(form.username);
  if (username) errors.username = username;
  if (form.displayName.trim().length > DISPLAY_NAME_MAX) errors.displayName = `At most ${DISPLAY_NAME_MAX} characters.`;
  if (form.password.length < PASSWORD_MIN) errors.password = `At least ${PASSWORD_MIN} characters.`;
  else if (form.password !== form.confirm) errors.confirm = "The passwords do not match.";
  return errors;
}

export function hasProblems(errors: RegisterErrors): boolean {
  return Object.values(errors).some(Boolean);
}

export function checkLine(check: { valid: boolean; invitedBy?: string; groupName?: string | null }): string {
  if (!check.valid) return "This invite code is not valid";
  const by = check.invitedBy ? `Invited by ${check.invitedBy}` : "Invite code accepted";
  return check.groupName ? `${by} · joins ${check.groupName}` : by;
}

export type CodeChip = { label: string; tone: "open" | "used" | "gone" };

// How a code is listed: open ones say when they run out, used ones who took them.
export function codeChip(code: Pick<InviteCode, "status" | "expiresAt" | "usedBy" | "usedAt">, when: (iso: string) => string): CodeChip {
  switch (code.status) {
    case "open":
      return { label: `Open · until ${when(code.expiresAt)}`, tone: "open" };
    case "used":
      return { label: `Used by ${code.usedBy?.displayName ?? "someone"}${code.usedAt ? ` · ${when(code.usedAt)}` : ""}`, tone: "used" };
    case "expired":
      return { label: "Expired", tone: "gone" };
    default:
      return { label: "Revoked", tone: "gone" };
  }
}

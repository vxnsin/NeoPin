import crypto from "crypto";
import fs from "fs";
import chalk from "chalk";
import { config } from "./config.js";
import { deletePushToken } from "./push.js";

// Firebase Cloud Messaging over HTTP v1, without the Firebase SDK. The access token comes from
// a JWT signed with the service account key.
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const REQUEST_TIMEOUT_MS = 10_000;
// A wake-up per device at most this often.
export const WAKE_COOLDOWN_MS = 10_000;
// Errors that mean the token is dead.
const DEAD_TOKEN = new Set(["UNREGISTERED", "NOT_FOUND", "INVALID_ARGUMENT"]);

let loaded = { source: undefined, account: null };
let cached = null;
let pending = null;
const lastWake = new Map();

function warn(text) {
  console.log(chalk.yellow(`[!] Push: ${text}`));
}

// The service account, read again when the configured source changes. Null when push is off
// or the key is unusable.
function serviceAccount() {
  const source = config.fcmServiceAccountJson ?? config.fcmServiceAccountFile ?? null;
  if (source === loaded.source) return loaded.account;
  let account = null;
  if (source) {
    try {
      const raw = config.fcmServiceAccountJson ?? fs.readFileSync(config.fcmServiceAccountFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.client_email && parsed.private_key && parsed.project_id) {
        account = {
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key,
          projectId: parsed.project_id,
          tokenUri: parsed.token_uri || "https://oauth2.googleapis.com/token",
        };
      } else warn("the service account has no client_email, private_key or project_id, push stays off.");
    } catch (error) {
      warn(`the service account could not be read (${error.message}), push stays off.`);
    }
  }
  loaded = { source, account };
  return account;
}

export const fcmEnabled = () => serviceAccount() !== null;

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signedJwt(account, tokenUrl) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({
    iss: account.clientEmail,
    scope: SCOPE,
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), account.privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function fetchAccessToken(account) {
  const tokenUrl = config.fcmTokenUrl || account.tokenUri;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt(account, tokenUrl),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`token exchange answered ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error("token exchange gave no access_token");
  return { value: body.access_token, expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000 };
}

// Cached until a minute before it expires, a burst of messages shares one exchange.
async function accessToken(account) {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  pending ??= fetchAccessToken(account)
    .then((token) => (cached = token))
    .finally(() => (pending = null));
  return (await pending).value;
}

async function post(account, message) {
  const url = config.fcmUrl || `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`;
  const go = async () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await accessToken(account)}` },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  let res = await go();
  if (res.status === 401) {
    cached = null;
    res = await go();
  }
  return res;
}

// Sends one message to a stored token. Never throws. True when FCM took it; a token FCM calls
// dead is deleted.
async function deliver(target, body) {
  const account = serviceAccount();
  if (!account) return false;
  try {
    const res = await post(account, { token: target.token, ...body });
    if (res.ok) return true;
    const error = (await res.json().catch(() => ({})))?.error ?? {};
    const codes = [error.status, ...(error.details ?? []).map((d) => d.errorCode)];
    if (codes.some((code) => DEAD_TOKEN.has(code))) {
      deletePushToken(target.userId, target.deviceId);
      console.log(chalk.cyan(`[i] Push: the token of ${chalk.whiteBright(target.deviceId)} is dead, removed it.`));
    } else warn(`FCM answered ${res.status} ${error.status ?? ""} ${error.message ?? ""}`.trim());
  } catch (error) {
    warn(`FCM could not be reached (${error.message}).`);
  }
  return false;
}

// A data-only high-priority message wakes the app in the background even when it is not
// running. Answers "sent", "throttled" (one went out a moment ago) or "failed".
export async function sendWakeUp(target, { from = "" } = {}) {
  if (!fcmEnabled()) return "failed";
  const key = `${target.userId}:${target.deviceId}`;
  const now = Date.now();
  if (now - (lastWake.get(key) ?? 0) < WAKE_COOLDOWN_MS) return "throttled";
  lastWake.set(key, now);
  const ok = await deliver(target, {
    data: { type: "requestLocation", from, id: crypto.randomUUID() },
    android: { priority: "HIGH", ttl: "60s" },
  });
  if (!ok) lastWake.delete(key);
  return ok ? "sent" : "failed";
}

// A visible notification. `data` carries the type and whatever the app needs to open the right screen.
export function sendNotification(target, { title, body, data = {} }) {
  if (!fcmEnabled()) return Promise.resolve(false);
  return deliver(target, {
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])),
    android: { priority: "HIGH", notification: { channel_id: "default" } },
  });
}

export function resetFcm() {
  loaded = { source: undefined, account: null };
  cached = null;
  pending = null;
  lastWake.clear();
}

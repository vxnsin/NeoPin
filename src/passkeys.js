import net from "node:net";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { config } from "./config.js";
import { getDb } from "./db.js";

// Passkeys sign in to the dashboard without a password. Each account may add several; the
// login asks the browser for any passkey of this server (discoverable credentials), so it
// needs no username. The app keeps its password login and device token.

const RP_NAME = "NeoPin";
export const CHALLENGE_TTL_MS = 5 * 60_000;
// Asking for options needs no account, so the open challenges are capped.
const MAX_CHALLENGES = 1000;
export const PASSKEY_NAME_MAX = 40;

const hostnameOf = (host) => {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
};

// Passkeys belong to a host name: PUBLIC_URL's, otherwise the Host the request came to.
// Browsers only offer them on HTTPS pages and on localhost, and never for an IP address.
// Null when this request cannot use them.
export function relyingParty({ host, secure }) {
  if (!config.publicUrl && !host) return null;
  let url;
  try {
    url = new URL(config.publicUrl ?? `${secure ? "https" : "http"}://${host}`);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, ""))) return null;
  // Opened by another address than PUBLIC_URL (the LAN IP, say): the browser would refuse.
  if (config.publicUrl && host && hostnameOf(host) !== url.hostname) return null;
  return { id: url.hostname, origin: url.origin };
}

// ---- challenges ----

// Every challenge works once, for what it was made for, on the host it was made on.
const challenges = new Map();

function remember(challenge, entry) {
  const now = Date.now();
  for (const [key, open] of challenges) if (open.expiresAt <= now) challenges.delete(key);
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
  challenges.set(challenge, { ...entry, expiresAt: now + CHALLENGE_TTL_MS });
}

function take(challenge, purpose, rp, userId = null) {
  const entry = challenges.get(challenge);
  if (!entry) return false;
  challenges.delete(challenge);
  return entry.purpose === purpose && entry.rpId === rp.id && entry.userId === userId && entry.expiresAt > Date.now();
}

export function resetPasskeyChallenges() {
  challenges.clear();
}

// ---- stored passkeys ----

const failed = (message) => Object.assign(new Error(message), { code: "passkey-failed" });

const transportsOf = (row) => {
  try {
    return row.transports ? JSON.parse(row.transports) : undefined;
  } catch {
    return undefined;
  }
};

const publicPasskey = (row) => ({
  id: Number(row.id),
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at ?? null,
});

const rowsOf = (userId) => getDb().prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY id").all(userId);

export const listPasskeys = (userId) => rowsOf(userId).map(publicPasskey);

export function deletePasskey(userId, id) {
  return getDb().prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

// The user handle the authenticator keeps with the passkey: the account id, nothing personal.
const userHandle = (userId) => new TextEncoder().encode(String(userId));

// ---- registration ----

export async function registrationOptions(user, rp) {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.id,
    userName: user.username,
    userDisplayName: user.display_name,
    userID: userHandle(user.id),
    attestationType: "none",
    // The same authenticator twice for one account helps nobody.
    excludeCredentials: rowsOf(user.id).map((row) => ({ id: row.credential_id, transports: transportsOf(row) })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    timeout: CHALLENGE_TTL_MS,
  });
  remember(options.challenge, { purpose: "register", userId: user.id, rpId: rp.id });
  return options;
}

export async function registerPasskey(user, rp, response, name) {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: (challenge) => take(challenge, "register", rp, user.id),
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
  } catch (error) {
    throw failed(error.message);
  }
  if (!verification.verified) throw failed("The passkey could not be verified");
  const { credential } = verification.registrationInfo;
  const db = getDb();
  if (db.prepare("SELECT 1 FROM passkeys WHERE credential_id = ?").get(credential.id)) throw failed("This passkey is already added");
  const result = db
    .prepare(
      "INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      user.id,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports?.length ? JSON.stringify(credential.transports) : null,
      name,
      new Date().toISOString()
    );
  return publicPasskey(db.prepare("SELECT * FROM passkeys WHERE id = ?").get(result.lastInsertRowid));
}

// ---- login ----

export async function loginOptions(rp) {
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "preferred", timeout: CHALLENGE_TTL_MS });
  remember(options.challenge, { purpose: "login", userId: null, rpId: rp.id });
  return options;
}

// The account the passkey belongs to, once its signature checks out. Throws otherwise.
export async function verifyPasskeyLogin(rp, response) {
  const db = getDb();
  const row = typeof response?.id === "string" ? db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").get(response.id) : null;
  if (!row) throw failed("This passkey is not known here");
  // The authenticator names the account it made the passkey for, and that has to be its owner.
  const handle = response.response?.userHandle;
  if (handle && Buffer.from(handle, "base64url").toString() !== String(row.user_id)) throw failed("This passkey belongs to someone else");
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (challenge) => take(challenge, "login", rp),
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: Number(row.counter),
        transports: transportsOf(row),
      },
      requireUserVerification: false,
    });
  } catch (error) {
    throw failed(error.message);
  }
  if (!verification.verified) throw failed("The passkey could not be verified");
  db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(
    verification.authenticationInfo.newCounter,
    new Date().toISOString(),
    row.id
  );
  return Number(row.user_id);
}

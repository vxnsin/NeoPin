// Passkeys in the browser: the server sends WebAuthn options as JSON (base64url for the bytes),
// navigator.credentials wants bytes and hands bytes back. Used by the login and the dashboard.

const fromBase64url = (text) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)), (c) => c.charCodeAt(0));

function toBase64url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function passkeysSupported() {
  return typeof window.PublicKeyCredential === "function" && Boolean(navigator.credentials) && window.isSecureContext;
}

const withIds = (list) => (list ?? []).map((c) => ({ ...c, id: fromBase64url(c.id) }));

function credentialJson(credential) {
  // Newer browsers do this themselves.
  if (typeof credential.toJSON === "function") {
    try {
      return credential.toJSON();
    } catch {
      // fall through to doing it by hand
    }
  }
  const r = credential.response;
  const json = {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: { clientDataJSON: toBase64url(r.clientDataJSON) },
  };
  if (credential.authenticatorAttachment) json.authenticatorAttachment = credential.authenticatorAttachment;
  if (r.attestationObject) {
    json.response.attestationObject = toBase64url(r.attestationObject);
    json.response.transports = r.getTransports?.() ?? [];
  } else {
    json.response.authenticatorData = toBase64url(r.authenticatorData);
    json.response.signature = toBase64url(r.signature);
    if (r.userHandle) json.response.userHandle = toBase64url(r.userHandle);
  }
  return json;
}

async function createPasskey(options) {
  const publicKey = {
    ...options,
    challenge: fromBase64url(options.challenge),
    user: { ...options.user, id: fromBase64url(options.user.id) },
    excludeCredentials: withIds(options.excludeCredentials),
  };
  return credentialJson(await navigator.credentials.create({ publicKey }));
}

async function getPasskey(options) {
  const publicKey = { ...options, challenge: fromBase64url(options.challenge), allowCredentials: withIds(options.allowCredentials) };
  return credentialJson(await navigator.credentials.get({ publicKey }));
}

// What to tell the person when the browser gave up. Null when they just cancelled.
function passkeyErrorText(error, creating) {
  if (error?.name === "NotAllowedError" || error?.name === "AbortError") return null;
  if (creating && error?.name === "InvalidStateError") return "This device already has a passkey for your account.";
  if (error?.name === "SecurityError") return "Passkeys do not work on this address. Open the dashboard by its HTTPS address.";
  return creating ? "The passkey could not be created." : "The passkey could not be used.";
}

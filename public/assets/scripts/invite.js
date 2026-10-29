// /invite/CODE: the link people share instead of neopin://, which messengers do not make
// clickable. The app gets the code and this server's address, so nothing has to be typed.
const ANDROID_PACKAGE = "de.vensin.neopin";

const lead = document.getElementById("lead");
const codeLine = document.getElementById("code");
const message = document.getElementById("message");
const actions = document.getElementById("actions");
const openApp = document.getElementById("openApp");
const openWeb = document.getElementById("openWeb");

const code = normaliseInviteCode(decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] ?? ""));
const webLink = `/login?code=${encodeURIComponent(code)}`;

// What the app's invite route reads. Android's intent link falls back to the sign-up here when
// the app is not installed; other phones only know the scheme.
function appLink() {
  // The server goes without its scheme: a "://" in the query kept the app from finding its route.
  const secure = location.protocol === "https:" ? "" : "&secure=0";
  const query = `code=${encodeURIComponent(code)}&server=${encodeURIComponent(location.host)}${secure}`;
  if (!/android/i.test(navigator.userAgent)) return `neopin://invite?${query}`;
  const fallback = encodeURIComponent(new URL(webLink, location.origin).href);
  return `intent://invite?${query}#Intent;scheme=neopin;package=${ANDROID_PACKAGE};S.browser_fallback_url=${fallback};end`;
}

function notValid(text) {
  lead.textContent = text;
  message.textContent = "";
  actions.hidden = true;
  codeLine.textContent = "";
}

if (!isCompleteInviteCode(code)) {
  notValid("This invite link is not complete.");
} else {
  codeLine.textContent = formatInviteCode(code);
  openApp.href = appLink();
  openWeb.href = webLink;
  fetch("/api/invite-codes/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
    .then(async (response) => {
      if (response.status === 404) return notValid("This server does not take invite codes.");
      if (!response.ok) return;
      const result = await response.json();
      if (!result.valid) return notValid("This invite code is used up or no longer valid.");
      lead.textContent = result.groupName
        ? `${result.invitedBy} invited you to ${result.groupName}.`
        : `${result.invitedBy} invited you to NeoPin.`;
    })
    .catch(() => {});
}

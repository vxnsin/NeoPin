// Passkeys of the signed-in account: add one on this device, see them, delete them.
const passkeyDialogOpen = () => !modal.hidden && modalTitle.textContent === "Passkeys";

const shortDate = (iso) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

// "iPhone", "Mac", "Windows" from the browser, as the default name.
function deviceGuess() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "";
}

function passkeyRow(passkey) {
  const used = passkey.lastUsedAt ? `last used ${timeAgo(passkey.lastUsedAt)}` : "not used yet";
  return `
    <li class="row" data-id="${passkey.id}">
      <span class="row__icon"><svg class="icon"><use href="#i-fingerprint" /></svg></span>
      <span class="row__text">
        <strong>${esc(passkey.name)}</strong>
        <span>Added ${esc(shortDate(passkey.createdAt))} · ${esc(used)}</span>
      </span>
      <button class="btn btn--small btn--ghost" type="button" data-delete-passkey>Delete</button>
    </li>`;
}

function renderPasskeys(list) {
  modalBody.innerHTML = `
    <form class="new-account" id="newPasskey" novalidate>
      <strong>Add a passkey</strong>
      <p class="hint">Sign in to the dashboard with your fingerprint, face, device PIN or a security key instead of the password. The app keeps using the password.</p>
      <label class="field-label">Name
        <input class="select" name="name" maxlength="40" placeholder="e.g. iPhone" autocomplete="off" value="${esc(deviceGuess())}" />
      </label>
      <p class="form-error" role="alert"></p>
      <button class="btn" type="submit">Add passkey</button>
    </form>
    <h3 class="gsection">Your passkeys</h3>
    ${
      list.length
        ? `<ul class="rows">${list.map(passkeyRow).join("")}</ul>`
        : '<div class="tl-note"><strong>No passkeys yet</strong>Add one above, then sign in with it on the login page.</div>'
    }`;
}

async function showPasskeys() {
  openModal("Passkeys");
  note('<div class="spinner"></div>');
  try {
    const list = await call("/api/passkeys");
    if (passkeyDialogOpen()) renderPasskeys(list);
  } catch (error) {
    if (error.message !== "signed-out") note(`<strong>Could not load the passkeys</strong>${esc(error.message)}`);
  }
}

modalBody.addEventListener("submit", async (event) => {
  if (!passkeyDialogOpen() || event.target.id !== "newPasskey") return;
  event.preventDefault();
  const form = event.target;
  const error = form.querySelector(".form-error");
  const submit = form.querySelector("[type=submit]");
  error.textContent = "";
  submit.disabled = true;
  try {
    const options = await call("/api/passkeys/register/options", { method: "POST" });
    let credential;
    try {
      credential = await createPasskey(options);
    } catch (failure) {
      const text = passkeyErrorText(failure, true);
      if (text) error.textContent = text;
      submit.disabled = false;
      return;
    }
    await call("/api/passkeys/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: form.name.value.trim(), credential }),
    });
    toast("Passkey added.");
    if (passkeyDialogOpen()) renderPasskeys(await call("/api/passkeys"));
  } catch (failure) {
    if (failure.message === "signed-out") return;
    error.textContent = failure.message;
    submit.disabled = false;
  }
});

modalBody.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-passkey]");
  if (!button || !passkeyDialogOpen()) return;
  const row = button.closest(".row");
  confirmRemove(button, "Delete this passkey?", async () => {
    await call(`/api/passkeys/${row.dataset.id}`, { method: "DELETE" });
    toast("Passkey deleted.");
    if (passkeyDialogOpen()) renderPasskeys(await call("/api/passkeys"));
  });
});

document.getElementById("openPasskeys").addEventListener("click", () => {
  setMenu(false);
  showPasskeys();
});

// Only offered where the browser and the address allow it: HTTPS, or localhost.
fetch("/api/status")
  .then((response) => (response.ok ? response.json() : null))
  .then((status) => {
    document.getElementById("openPasskeys").hidden = !(status?.passkeys && passkeysSupported());
  })
  .catch(() => {});

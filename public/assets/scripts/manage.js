// Dialogs for the account menu: the signed-in user's linked devices and, for the admin, all accounts.
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
let modalOpener = null;

function openModal(title) {
  modalTitle.textContent = title;
  modalBody.replaceChildren();
  modalOpener = document.activeElement;
  modal.hidden = false;
  document.getElementById("modalClose").focus();
}

function closeModal() {
  modal.hidden = true;
  modalBody.replaceChildren();
  modalOpener?.focus?.();
}

document.getElementById("modalClose").addEventListener("click", closeModal);
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modal.hidden) closeModal();
});

async function call(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("signed-out");
  }
  if (response.ok) return response.status === 204 ? null : response.json();
  let text = "The request failed.";
  try {
    const body = await response.json();
    text = body.detail || body.message || text;
  } catch {
    // keep the generic text
  }
  throw new Error(text);
}

function note(html) {
  modalBody.innerHTML = `<div class="tl-note">${html}</div>`;
}

// A row's remove button asks again in place before it does anything.
function confirmRemove(button, label, action) {
  const row = button.closest(".row");
  const bar = document.createElement("div");
  bar.className = "row__confirm";
  bar.innerHTML = `<span>${esc(label)}</span><button class="btn btn--small btn--ghost" type="button" data-no>Cancel</button><button class="btn btn--small btn--danger" type="button" data-yes>Confirm</button>`;
  button.hidden = true;
  row.append(bar);
  bar.querySelector("[data-no]").addEventListener("click", () => {
    bar.remove();
    button.hidden = false;
  });
  bar.querySelector("[data-yes]").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await action();
    } catch (error) {
      if (error.message === "signed-out") return;
      toast(error.message);
      bar.remove();
      button.hidden = false;
    }
  });
}

// My devices

function statusText(device) {
  if (device.status === "online") return "Online now";
  return device.lastPing ? `Last seen ${timeAgo(device.lastPing)}` : "Never reported a position";
}

async function showDevices() {
  openModal("My devices");
  note('<div class="spinner"></div>');
  try {
    const list = await call("/api/devices");
    if (list.length === 0) {
      note(
        '<span class="empty__icon"><svg class="icon"><use href="#i-phone" /></svg></span><strong>No devices linked</strong>Sign in with the NeoPin app and the phone shows up here.'
      );
      return;
    }
    const items = list
      .map(
        (device) => `
        <li class="row" data-id="${esc(device.deviceId)}">
          <span class="row__dot" data-state="${device.status === "online" ? "online" : "offline"}"></span>
          <span class="row__text">
            <strong>${typeIcon(device)}${esc(device.deviceId)}</strong>
            <span>${esc(statusText(device))} · linked ${esc(new Date(device.linkedAt).toLocaleDateString())}</span>
          </span>
          <button class="btn btn--small btn--ghost" type="button" data-unlink>Unlink</button>
        </li>`
      )
      .join("");
    modalBody.innerHTML = `<ul class="rows">${items}</ul>`;
    modalBody.querySelectorAll("[data-unlink]").forEach((button) => {
      const row = button.closest(".row");
      button.addEventListener("click", () =>
        confirmRemove(button, "Unlink this device?", async () => {
          await call(`/api/devices/${encodeURIComponent(row.dataset.id)}`, { method: "DELETE" });
          toast("Device unlinked.");
          showDevices();
        })
      );
    });
  } catch (error) {
    if (error.message !== "signed-out") note(`<strong>Could not load the devices</strong>${esc(error.message)}`);
  }
}

// Accounts (admin)

async function showAccounts() {
  openModal("Accounts");
  note('<div class="spinner"></div>');
  try {
    const users = await call("/api/users");
    const items = users
      .map(
        (user) => `
        <li class="row" data-id="${user.id}">
          ${accountAvatarHtml(user, "sm")}
          <span class="row__text">
            <strong>${esc(user.displayName || user.username)}${user.isAdmin ? ' <span class="badge">Admin</span>' : ""}</strong>
            <span>@${esc(user.username)} · ${user.devices} ${user.devices === 1 ? "device" : "devices"}</span>
          </span>
          ${user.id === me?.id ? "" : '<button class="btn btn--small btn--ghost" type="button" data-remove>Remove</button>'}
        </li>`
      )
      .join("");
    modalBody.innerHTML = `
      <ul class="rows">${items}</ul>
      <form class="new-account" id="newAccount" novalidate>
        <strong>New account</strong>
        <input class="select" name="username" placeholder="Username" autocomplete="off" autocapitalize="none" spellcheck="false" required />
        <input class="select" name="displayName" placeholder="Display name (optional)" autocomplete="off" maxlength="64" />
        <input class="select" name="password" type="password" placeholder="Password (8+ characters)" autocomplete="new-password" required />
        <p class="form-error" id="newAccountError" role="alert"></p>
        <button class="btn" type="submit">Create account</button>
      </form>`;
    modalBody.querySelectorAll("[data-remove]").forEach((button) => {
      const row = button.closest(".row");
      button.addEventListener("click", () =>
        confirmRemove(button, "Remove the account and its devices?", async () => {
          await call(`/api/users/${row.dataset.id}`, { method: "DELETE" });
          toast("Account removed.");
          showAccounts();
        })
      );
    });
    const form = document.getElementById("newAccount");
    const error = document.getElementById("newAccountError");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const submit = form.querySelector("button[type=submit]");
      submit.disabled = true;
      error.textContent = "";
      try {
        await call("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: data.username.trim(),
            password: data.password,
            ...(data.displayName.trim() && { displayName: data.displayName.trim() }),
          }),
        });
        toast("Account created.");
        showAccounts();
      } catch (failure) {
        if (failure.message !== "signed-out") error.textContent = failure.message;
        submit.disabled = false;
      }
    });
  } catch (error) {
    if (error.message !== "signed-out") note(`<strong>Could not load the accounts</strong>${esc(error.message)}`);
  }
}

document.getElementById("openDevices").addEventListener("click", () => {
  setMenu(false);
  showDevices();
});
document.getElementById("openAccounts").addEventListener("click", () => {
  setMenu(false);
  showAccounts();
});

// Change password

function showPassword() {
  openModal("Change password");
  modalBody.innerHTML = `
    <form class="new-account" id="passwordForm" novalidate>
      <input class="select" name="current" type="password" placeholder="Current password" autocomplete="current-password" required />
      <input class="select" name="next" type="password" placeholder="New password (8+ characters)" autocomplete="new-password" required />
      <input class="select" name="again" type="password" placeholder="Repeat the new password" autocomplete="new-password" required />
      <p class="form-error" id="passwordError" role="alert"></p>
      <button class="btn" type="submit">Change password</button>
    </form>`;
  const form = document.getElementById("passwordForm");
  const error = document.getElementById("passwordError");
  form.current.focus();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.current.value) return (error.textContent = "Enter your current password.");
    if (form.next.value.length < 8) return (error.textContent = "The new password needs at least 8 characters.");
    if (form.next.value !== form.again.value) return (error.textContent = "The new passwords do not match.");
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    error.textContent = "";
    try {
      const response = await fetch("/api/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: form.current.value, newPassword: form.next.value }),
      });
      if (!response.ok) {
        let text = response.status === 401 ? "The current password is not right." : "The password could not be changed.";
        if (response.status === 400) text = (await response.json().catch(() => ({}))).detail || text;
        error.textContent = text;
        submit.disabled = false;
        return;
      }
      me.mustChangePassword = false;
      renderAccount();
      closeModal();
      toast("Password changed.");
    } catch {
      error.textContent = "The server is not reachable.";
      submit.disabled = false;
    }
  });
}

document.getElementById("openPassword").addEventListener("click", () => {
  setMenu(false);
  showPassword();
});
document.getElementById("pwBannerButton").addEventListener("click", showPassword);

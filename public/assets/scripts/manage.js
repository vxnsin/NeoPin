// Dialogs for the account menu: the signed-in user's linked devices and, for the admin, all accounts.
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
let modalOpener = null;
// Set by a dialog that has to hear about it when it is closed without its own buttons.
let modalCleanup = null;

function openModal(title) {
  modalCleanup = null;
  modalTitle.textContent = title;
  modalBody.replaceChildren();
  modalOpener = document.activeElement;
  modal.hidden = false;
  document.getElementById("modalClose").focus();
}

function closeModal() {
  const cleanup = modalCleanup;
  modalCleanup = null;
  cleanup?.();
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

// Chips for the groups a new account goes straight into. A click toggles one.
function groupPickerHtml(list, selected = []) {
  if (list.length === 0) return "";
  const chips = list
    .map((g) => `<button class="chip" type="button" data-pick-group="${g.id}" aria-pressed="${selected.includes(g.id)}">${esc(g.name)}</button>`)
    .join("");
  return `<div class="field-label">Groups (optional)<div class="chips chips--wrap chips--pick" role="group" aria-label="Groups">${chips}</div></div>`;
}

const pickedGroups = (root) => [...root.querySelectorAll("[data-pick-group][aria-pressed=true]")].map((b) => Number(b.dataset.pickGroup));

document.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-pick-group]");
  if (chip) chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
});

async function showAccounts() {
  openModal("Accounts");
  note('<div class="spinner"></div>');
  try {
    const [users, mine] = await Promise.all([call("/api/users"), call("/api/groups")]);
    const items = users
      .map(
        (user) => `
        <li class="row" data-id="${user.id}">
          ${accountAvatarHtml(user, "sm")}
          <span class="row__text">
            <strong>${esc(user.displayName || user.username)}${user.isAdmin ? ' <span class="badge">Admin</span>' : ""}</strong>
            <span>@${esc(user.username)} · ${user.devices} ${user.devices === 1 ? "device" : "devices"}</span>
          </span>
          <span class="row__actions">
            <button class="btn btn--small btn--ghost" type="button" data-edit>Edit</button>
            ${user.id === me?.id ? "" : '<button class="btn btn--small btn--ghost" type="button" data-remove>Remove</button>'}
          </span>
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
        ${groupPickerHtml(mine)}
        <p class="hint">Without a group the account sees only itself until someone invites it.</p>
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
    modalBody.querySelectorAll("[data-edit]").forEach((button) => {
      const row = button.closest(".row");
      button.addEventListener("click", () => editAccountRow(row, users.find((u) => String(u.id) === row.dataset.id)));
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
            groupIds: pickedGroups(form),
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

// Account editing for the admin: an inline form in the account's row.

function editAccountRow(row, user) {
  if (row.querySelector(".row__edit")) return;
  const form = document.createElement("form");
  form.className = "row__edit";
  form.noValidate = true;
  form.innerHTML = `
    <input class="select" name="displayName" placeholder="Display name" value="${esc(user.displayName)}" maxlength="64" />
    <input class="select" name="username" placeholder="Username" value="${esc(user.username)}" autocomplete="off" autocapitalize="none" spellcheck="false" />
    <input class="select" name="password" type="password" placeholder="Set new password (optional)" autocomplete="new-password" />
    <p class="hint">A new password signs this account's devices out.</p>
    <p class="form-error" role="alert"></p>
    <div class="row__edit-actions">
      <button class="btn btn--small btn--ghost" type="button" data-cancel>Cancel</button>
      <button class="btn btn--small" type="submit">Save</button>
    </div>`;
  row.append(form);
  form.displayName.focus();
  form.querySelector("[data-cancel]").addEventListener("click", () => form.remove());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = form.querySelector(".form-error");
    const body = {};
    if (form.displayName.value.trim() !== user.displayName) body.displayName = form.displayName.value.trim();
    if (form.username.value.trim() !== user.username) body.username = form.username.value.trim();
    if (form.password.value) body.password = form.password.value;
    if (Object.keys(body).length === 0) return form.remove();
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    error.textContent = "";
    try {
      const updated = await call(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (user.id === me?.id) applyOwnProfile(updated);
      toast("Account saved.");
      showAccounts();
    } catch (failure) {
      if (failure.message !== "signed-out") error.textContent = failure.message;
      submit.disabled = false;
    }
  });
}

// Edit profile

function applyOwnProfile(user) {
  me = { ...me, ...user };
  renderAccount();
  render();
}

function showProfile() {
  openModal("Edit profile");
  modalBody.innerHTML = `
    <form class="new-account" id="profileForm" novalidate>
      <label class="field-label">Display name<input class="select" name="displayName" value="${esc(me.displayName)}" maxlength="64" autocomplete="nickname" /></label>
      <label class="field-label">Username<input class="select" name="username" value="${esc(me.username)}" autocomplete="username" autocapitalize="none" spellcheck="false" /></label>
      <p class="hint">Your username is what you sign in with. Letters, digits, dot, dash and underscore.</p>
      <p class="form-error" id="profileError" role="alert"></p>
      <button class="btn" type="submit">Save</button>
    </form>`;
  const form = document.getElementById("profileForm");
  const error = document.getElementById("profileError");
  form.displayName.focus();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {};
    if (form.displayName.value.trim() !== me.displayName) body.displayName = form.displayName.value.trim();
    if (form.username.value.trim() !== me.username) body.username = form.username.value.trim();
    if (Object.keys(body).length === 0) return closeModal();
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    error.textContent = "";
    try {
      applyOwnProfile(
        await call("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      );
      closeModal();
      toast("Profile saved.");
    } catch (failure) {
      if (failure.message !== "signed-out") error.textContent = failure.message;
      submit.disabled = false;
    }
  });
}

document.getElementById("openProfile").addEventListener("click", () => {
  setMenu(false);
  showProfile();
});

// Invisible: the choices and labels come from hidden.js.

const isHiddenNow = () => me?.hiddenUntil != null && me.hiddenUntil > Date.now();

function showHide() {
  openModal("Invisible");
  renderHide();
}

// Drawn again after each change, in the same dialog, so the focus stays in it.
function renderHide() {
  const active = isHiddenNow();
  modalBody.innerHTML = `
    <div class="hide">
      ${
        active
          ? `<div class="hide__active">
              <svg class="icon"><use href="#i-eye-off" /></svg>
              <strong>${esc(hiddenLabel(me.hiddenUntil))}</strong>
              <button class="btn btn--small" type="button" data-show aria-label="Show me again">Show me</button>
            </div>`
          : `<div class="hide__choices">${HIDE_CHOICES.map(
              (choice, i) => `<button class="btn btn--ghost" type="button" data-hide="${i}" aria-label="Hide me: ${esc(choice.label)}">${esc(choice.label)}</button>`
            ).join("")}</div>`
      }
      <p class="hint">${
        active
          ? "Nobody else sees you on the map, not even the admin. Your own map and timeline go on."
          : "Gone from everyone else's map for a while. It turns itself off again, also when this page is closed."
      }</p>
      <p class="form-error" role="alert"></p>
    </div>`;
  const error = modalBody.querySelector(".form-error");
  modalBody.querySelector(".hide").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-hide], [data-show]");
    if (!button) return;
    const minutes = button.dataset.hide === undefined ? undefined : HIDE_CHOICES[Number(button.dataset.hide)].minutes(new Date());
    modalBody.querySelectorAll(".hide button").forEach((b) => (b.disabled = true));
    error.textContent = "";
    try {
      const user =
        button.dataset.show !== undefined
          ? await call("/api/me/hidden", { method: "DELETE" })
          : await call("/api/me/hidden", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(minutes ? { minutes } : {}),
            });
      applyOwnProfile(user);
      renderHide();
      modalBody.querySelector(".hide button")?.focus();
    } catch (failure) {
      if (failure.message === "signed-out") return;
      error.textContent = failure.message || "That did not work, try again.";
      modalBody.querySelectorAll(".hide button").forEach((b) => (b.disabled = false));
    }
  });
}

document.getElementById("openHide").addEventListener("click", () => {
  setMenu(false);
  showHide();
});

// Groups decide who sees whom. The dialog manages them, the chips on the people panel filter by them.
const chipsEl = document.getElementById("groupChips");
const groupsDot = document.getElementById("groupsDot");
const accountDot = document.getElementById("accountDot");

let groups = [];
let invites = [];

const groupsDialogOpen = () => !modal.hidden && modalTitle.textContent === "Groups";

// Chips on the people panel

const isChipGroup = (id) => groups.some((g) => g.id === id);

// Chips only when one would show something All does not: two groups or more. Same rule as the app.
function renderChips() {
  if (groups.length < 2) {
    chipsEl.hidden = true;
    return;
  }
  const chip = (id, label) =>
    `<button class="chip" type="button" data-group="${id ?? ""}" aria-pressed="${groupFilter === id}">${esc(label)}</button>`;
  chipsEl.innerHTML = chip(null, "All") + groups.map((g) => chip(g.id, g.name)).join("");
  chipsEl.hidden = false;
}

chipsEl.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-group]");
  if (chip) setGroupFilter(chip.dataset.group === "" ? null : Number(chip.dataset.group));
});

// The choice sticks per account, in this browser.
function restoreFilter() {
  let saved = null;
  try {
    saved = me ? localStorage.getItem(`neopin.group.${me.id}`) : null;
  } catch {
    saved = null;
  }
  const id = saved && saved !== "all" ? Number(saved) : null;
  // A saved pick of a group that is gone is All now.
  groupFilter = id !== null && isChipGroup(id) ? id : null;
  devices = filterDevices();
  render();
}

// State

function updateDots() {
  const pending = invites.length > 0;
  groupsDot.hidden = !pending;
  accountDot.hidden = !pending;
}

async function refreshGroups({ restore = false } = {}) {
  try {
    [groups, invites] = await Promise.all([call("/api/groups"), call("/api/invites")]);
  } catch {
    return;
  }
  updateDots();
  // The chosen group may be gone, then everybody is shown again.
  if (restore) restoreFilter();
  else if (groupFilter !== null && !isChipGroup(groupFilter)) setGroupFilter(null);
  renderChips();
  if (groupsDialogOpen()) renderGroupsDialog();
}

document.addEventListener("groupschanged", () => refreshGroups());
meReady.then(() => refreshGroups({ restore: true }));

// Dialog

const roleTag = (role) => `<span class="tag">${role === "owner" ? "Owner" : "Member"}</span>`;
const personName = (user) => esc(user.displayName || user.username);

function memberRow(group, member) {
  const removable = group.canManage && member.role !== "owner" && member.id !== me?.id;
  return `
    <li class="row" data-user="${member.id}">
      ${accountAvatarHtml(member, "sm")}
      <span class="row__text">
        <strong>${personName(member)}${roleTag(member.role)}</strong>
        <span>@${esc(member.username)}</span>
      </span>
      ${removable ? '<button class="btn btn--small btn--ghost" type="button" data-remove-member>Remove</button>' : ""}
    </li>`;
}

function pendingRow(invite) {
  return `
    <li class="row row--pending" data-invite="${invite.id}">
      ${accountAvatarHtml(invite.user, "sm")}
      <span class="row__text">
        <strong>${personName(invite.user)}<span class="tag">Invited</span></strong>
        <span>@${esc(invite.user.username)}</span>
      </span>
      <button class="btn btn--small btn--ghost" type="button" data-cancel-invite>Cancel</button>
    </li>`;
}

function groupCard(group) {
  const members = group.members.map((m) => memberRow(group, m)).join("");
  const pending = (group.pendingInvites ?? []).map(pendingRow).join("");
  const invites = `
      <form class="group__form" data-invite-form novalidate>
        <div class="combo">
          <input class="select" name="username" placeholder="Invite by username" autocomplete="off" autocapitalize="none" spellcheck="false"
            role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="suggest-${group.id}" aria-label="Invite by username" />
          <ul class="combo__list" id="suggest-${group.id}" role="listbox" aria-label="Matching people" hidden></ul>
        </div>
        <button class="btn btn--small" type="submit">Invite</button>
      </form>`;
  const manage = group.canManage
    ? `${invites}
      <form class="group__form" data-rename-form novalidate hidden>
        <input class="select" name="name" value="${esc(group.name)}" maxlength="40" aria-label="Group name" />
        <button class="btn btn--small" type="submit">Save</button>
      </form>`
    : "";
  return `
    <section class="group" data-group="${group.id}">
      <div class="row group__head">
        <span class="row__text"><strong>${esc(group.name)}${roleTag(group.role)}</strong><span>${group.members.length} ${group.members.length === 1 ? "person" : "people"}</span></span>
        <span class="row__actions">
          ${group.canManage ? '<button class="btn btn--small btn--ghost" type="button" data-rename>Rename</button>' : ""}
          ${group.canManage ? '<button class="btn btn--small btn--ghost" type="button" data-delete>Delete</button>' : ""}
          ${group.role === "member" ? '<button class="btn btn--small btn--ghost" type="button" data-leave>Leave</button>' : ""}
        </span>
      </div>
      <ul class="rows">${members}${pending}</ul>
      ${manage}
      <p class="form-error" role="alert"></p>
    </section>`;
}

function renderGroupsDialog() {
  const inviteRows = invites
    .map(
      (invite) => `
      <li class="row" data-invite-id="${invite.id}">
        <span class="row__text">
          <strong>${esc(invite.groupName)}</strong>
          <span>Invited by ${personName(invite.invitedBy)}</span>
        </span>
        <span class="row__actions">
          <button class="btn btn--small btn--ghost" type="button" data-decline>Decline</button>
          <button class="btn btn--small" type="button" data-accept>Accept</button>
        </span>
      </li>`
    )
    .join("");
  modalBody.innerHTML = `
    ${invites.length ? `<h3 class="gsection">Invitations</h3><ul class="rows">${inviteRows}</ul>` : ""}
    <h3 class="gsection">My groups</h3>
    ${groups.length ? groups.map(groupCard).join("") : '<div class="tl-note"><strong>No groups yet</strong>Create one and invite people to see each other on the map.</div>'}
    <form class="new-account" id="newGroup" novalidate>
      <strong>Create group</strong>
      <input class="select" name="name" placeholder="Group name" maxlength="40" autocomplete="off" />
      <p class="form-error" role="alert"></p>
      <button class="btn" type="submit">Create group</button>
    </form>`;
}

async function showGroups() {
  openModal("Groups");
  note('<div class="spinner"></div>');
  await refreshGroups();
  if (groupsDialogOpen()) renderGroupsDialog();
}

// Runs an action, then reloads. Errors land in the section's message line, or a toast.
async function act(action, errorEl) {
  try {
    await action();
    await refreshGroups();
  } catch (error) {
    if (error.message === "signed-out") return;
    if (errorEl) errorEl.textContent = error.message;
    else toast(error.message);
  }
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

modalBody.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !groupsDialogOpen()) return;
  const section = button.closest(".group");
  const groupId = section?.dataset.group;
  const error = section?.querySelector(".form-error");
  if (error) error.textContent = "";

  if (button.matches("[data-accept], [data-decline]")) {
    const id = button.closest("[data-invite-id]").dataset.inviteId;
    act(() => call(`/api/invites/${id}/${button.matches("[data-accept]") ? "accept" : "decline"}`, { method: "POST" }));
  } else if (button.matches("[data-rename]")) {
    const form = section.querySelector("[data-rename-form]");
    form.hidden = !form.hidden;
    if (!form.hidden) form.name.focus();
  } else if (button.matches("[data-cancel-invite]")) {
    const id = button.closest("[data-invite]").dataset.invite;
    act(() => call(`/api/groups/${groupId}/invites/${id}`, { method: "DELETE" }), error);
  } else if (button.matches("[data-delete]")) {
    confirmRemove(button, "Delete this group for everyone?", () => act(() => call(`/api/groups/${groupId}`, { method: "DELETE" }), error));
  } else if (button.matches("[data-leave]")) {
    confirmRemove(button, "Leave this group?", () => act(() => call(`/api/groups/${groupId}/members/${me.id}`, { method: "DELETE" }), error));
  } else if (button.matches("[data-remove-member]")) {
    const userId = button.closest("[data-user]").dataset.user;
    confirmRemove(button, "Remove this person from the group?", () =>
      act(() => call(`/api/groups/${groupId}/members/${userId}`, { method: "DELETE" }), error)
    );
  }
});

modalBody.addEventListener("submit", (event) => {
  if (!groupsDialogOpen()) return;
  event.preventDefault();
  const form = event.target;
  const section = form.closest(".group");
  const error = form.querySelector(".form-error") ?? section?.querySelector(".form-error");
  if (error) error.textContent = "";

  if (form.id === "newGroup") {
    act(() => call("/api/groups", json("POST", { name: form.name.value.trim() })), error);
  } else if (form.matches("[data-invite-form]")) {
    const username = form.username.value.trim();
    if (!username) return;
    act(async () => {
      const result = await call(`/api/groups/${section.dataset.group}/invites`, json("POST", { username }));
      toast(result.message);
    }, error);
  } else if (form.matches("[data-rename-form]")) {
    act(() => call(`/api/groups/${section.dataset.group}`, json("PATCH", { name: form.name.value.trim() })), error);
  }
});

document.getElementById("openGroups").addEventListener("click", () => {
  setMenu(false);
  showGroups();
});

// Username suggestions under the invite input

const suggest = { timer: null, seq: 0, items: [], active: -1 };

const comboParts = (input) => ({ input, list: input.closest(".combo").querySelector(".combo__list") });

function closeSuggestions(input) {
  const { list } = comboParts(input);
  list.hidden = true;
  list.replaceChildren();
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  suggest.items = [];
  suggest.active = -1;
}

function setActive(input, index) {
  const { list } = comboParts(input);
  suggest.active = index;
  [...list.children].forEach((li, i) => {
    li.setAttribute("aria-selected", String(i === index));
    if (i === index) {
      input.setAttribute("aria-activedescendant", li.id);
      li.scrollIntoView({ block: "nearest" });
    }
  });
  if (index < 0) input.removeAttribute("aria-activedescendant");
}

function showSuggestions(input, users) {
  const { list } = comboParts(input);
  suggest.items = users;
  suggest.active = -1;
  if (users.length === 0) return closeSuggestions(input);
  list.innerHTML = users
    .map(
      (user, i) => `
      <li class="combo__option" role="option" id="${list.id}-${i}" aria-selected="false" data-index="${i}">
        ${accountAvatarHtml(user, "sm")}
        <span class="row__text"><strong>${personName(user)}</strong><span>@${esc(user.username)}</span></span>
      </li>`
    )
    .join("");
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function pickSuggestion(input, index) {
  const user = suggest.items[index];
  if (!user) return;
  input.value = user.username;
  closeSuggestions(input);
  input.focus();
}

modalBody.addEventListener("input", (event) => {
  const input = event.target;
  if (!input.matches("[data-invite-form] input[name=username]")) return;
  clearTimeout(suggest.timer);
  const q = input.value.trim();
  if (!q) return closeSuggestions(input);
  const groupId = input.closest(".group").dataset.group;
  const seq = ++suggest.seq;
  suggest.timer = setTimeout(async () => {
    try {
      const users = await call(`/api/users/search?q=${encodeURIComponent(q)}&groupId=${groupId}`);
      // Ignore answers for text that has changed since.
      if (seq === suggest.seq && input.isConnected && input.value.trim() === q) showSuggestions(input, users);
    } catch {
      // suggestions are a convenience, typing a name still works
    }
  }, 200);
});

modalBody.addEventListener("keydown", (event) => {
  const input = event.target;
  if (!input.matches?.("[data-invite-form] input[name=username]")) return;
  const open = input.getAttribute("aria-expanded") === "true";
  if (event.key === "ArrowDown" && suggest.items.length) {
    event.preventDefault();
    setActive(input, (suggest.active + 1) % suggest.items.length);
  } else if (event.key === "ArrowUp" && suggest.items.length) {
    event.preventDefault();
    setActive(input, (suggest.active - 1 + suggest.items.length) % suggest.items.length);
  } else if (event.key === "Enter" && open && suggest.active >= 0) {
    event.preventDefault();
    pickSuggestion(input, suggest.active);
  } else if (event.key === "Escape" && open) {
    // Only the list closes, not the whole dialog.
    event.preventDefault();
    event.stopPropagation();
    closeSuggestions(input);
  }
});

// Mouse down keeps the focus in the input, so the list does not close before the click lands.
modalBody.addEventListener("mousedown", (event) => {
  if (event.target.closest(".combo__option")) event.preventDefault();
});
modalBody.addEventListener("click", (event) => {
  const option = event.target.closest(".combo__option");
  if (!option) return;
  pickSuggestion(option.closest(".combo").querySelector("input"), Number(option.dataset.index));
});
modalBody.addEventListener("focusout", (event) => {
  if (!event.target.matches?.("[data-invite-form] input[name=username]")) return;
  const input = event.target;
  setTimeout(() => input.isConnected && closeSuggestions(input), 150);
});

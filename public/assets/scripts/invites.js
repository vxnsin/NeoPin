// Invite codes: make one, hand it on, see who used it, take it back.
let inviteState = { codes: [], groups: [], fresh: null };

const inviteDialogOpen = () => !modal.hidden && modalTitle.textContent === "Invite codes";

// Clipboard needs a secure page. On a plain http address the old way still works.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let done = false;
    try {
      done = document.execCommand("copy");
    } catch {
      done = false;
    }
    area.remove();
    return done;
  }
}

// The invite page opens the app, or the sign-up here when there is none.
const inviteLink = (code) => `${location.origin}/invite/${encodeURIComponent(code)}`;

function expiresText(iso) {
  const ms = Date.parse(iso) - Date.now();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `expires in ${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `expires in ${hours} h`;
}

function statusChip(invite) {
  if (invite.status === "open") return `<span class="tag tag--ok">Open · ${esc(expiresText(invite.expiresAt))}</span>`;
  if (invite.status === "used") {
    const who = invite.usedBy ? invite.usedBy.displayName || invite.usedBy.username : "someone";
    return `<span class="tag tag--used">Used by ${esc(who)} ${esc(timeAgo(invite.usedAt))}</span>`;
  }
  return `<span class="tag">${invite.status === "expired" ? "Expired" : "Revoked"}</span>`;
}

function inviteRow(invite) {
  const details = [];
  if (invite.groupName) details.push(`joins ${esc(invite.groupName)}`);
  if (invite.note) details.push(esc(invite.note));
  if (invite.createdBy && invite.createdBy.id !== me?.id) details.push(`by ${esc(invite.createdBy.displayName || invite.createdBy.username)}`);
  return `
    <li class="row invite" data-id="${invite.id}" data-status="${invite.status}">
      <span class="row__text">
        <strong class="invite__code">${esc(invite.code)}</strong>
        <span>${details.join(" · ") || "&nbsp;"}</span>
        <span class="invite__status">${statusChip(invite)}</span>
      </span>
      ${invite.status === "open" ? '<button class="btn btn--small btn--ghost" type="button" data-revoke>Revoke</button>' : ""}
    </li>`;
}

function renderInvites() {
  const { codes, groups: mine, fresh } = inviteState;
  const options = mine.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("");
  const freshBlock = fresh
    ? `
    <div class="invite-new">
      <span class="invite-new__label">New invite code</span>
      <strong class="invite-new__code" data-fresh-code>${esc(fresh.code)}</strong>
      <span class="hint">${fresh.groupName ? `Joins ${esc(fresh.groupName)}. ` : ""}${esc(expiresText(fresh.expiresAt))}.</span>
      <div class="row__edit-actions">
        <button class="btn btn--small btn--ghost" type="button" data-copy-code>Copy code</button>
        <button class="btn btn--small" type="button" data-copy-link>Copy link</button>
      </div>
    </div>`
    : "";
  modalBody.innerHTML = `
    <form class="new-account" id="newInvite" novalidate>
      <strong>Create code</strong>
      <label class="field-label">Group (optional)
        <select class="select" name="groupId"><option value="">No group</option>${options}</select>
      </label>
      <label class="field-label">Note (optional)
        <input class="select" name="note" maxlength="60" placeholder="Who is it for?" autocomplete="off" />
      </label>
      <p class="form-error" role="alert"></p>
      <button class="btn" type="submit">Create code</button>
    </form>
    ${freshBlock}
    <h3 class="gsection">Your codes</h3>
    ${codes.length ? `<ul class="rows">${codes.map(inviteRow).join("")}</ul>` : '<div class="tl-note"><strong>No codes yet</strong>A code lets one friend create an account.</div>'}`;
}

async function loadInvites() {
  const [codes, mine] = await Promise.all([call("/api/invite-codes"), call("/api/groups")]);
  inviteState.codes = codes;
  inviteState.groups = mine;
}

async function showInvites() {
  inviteState.fresh = null;
  openModal("Invite codes");
  note('<div class="spinner"></div>');
  try {
    await loadInvites();
    if (inviteDialogOpen()) renderInvites();
  } catch (error) {
    if (error.message !== "signed-out") note(`<strong>Could not load the codes</strong>${esc(error.message)}`);
  }
}

modalBody.addEventListener("submit", async (event) => {
  if (!inviteDialogOpen() || event.target.id !== "newInvite") return;
  event.preventDefault();
  const form = event.target;
  const error = form.querySelector(".form-error");
  error.textContent = "";
  const body = {};
  if (form.groupId.value) body.groupId = Number(form.groupId.value);
  if (form.note.value.trim()) body.note = form.note.value.trim();
  form.querySelector("[type=submit]").disabled = true;
  try {
    inviteState.fresh = await call("/api/invite-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await loadInvites();
    if (inviteDialogOpen()) renderInvites();
  } catch (failure) {
    if (failure.message === "signed-out") return;
    error.textContent = failure.message;
    form.querySelector("[type=submit]").disabled = false;
  }
});

modalBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || !inviteDialogOpen()) return;
  const fresh = inviteState.fresh;
  if (button.matches("[data-copy-code]")) {
    toast((await copyText(fresh.code)) ? "Code copied." : "Could not copy, select it by hand.");
  } else if (button.matches("[data-copy-link]")) {
    toast((await copyText(inviteLink(fresh.code))) ? "Link copied." : "Could not copy, select it by hand.");
  } else if (button.matches("[data-revoke]")) {
    const row = button.closest(".invite");
    confirmRemove(button, "Revoke this code?", async () => {
      await call(`/api/invite-codes/${row.dataset.id}`, { method: "DELETE" });
      if (inviteState.fresh && String(inviteState.fresh.id) === row.dataset.id) inviteState.fresh = null;
      await loadInvites();
      if (inviteDialogOpen()) renderInvites();
      toast("Code revoked.");
    });
  }
});

document.getElementById("openInvites").addEventListener("click", () => {
  setMenu(false);
  showInvites();
});

fetch("/api/status")
  .then((response) => (response.ok ? response.json() : null))
  .then((status) => {
    document.getElementById("openInvites").hidden = status?.invites === false;
  })
  .catch(() => {
    document.getElementById("openInvites").hidden = false;
  });

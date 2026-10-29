// Share my timeline: with nobody (the default), everyone in my groups, or chosen people and
// groups. Saved on every change. Whoever it is shared with reads it, nothing more.
const SHARING_TITLE = "Share my timeline";
const SHARE_MODES = [
  { mode: "off", label: "Nobody" },
  { mode: "groups", label: "Everyone in my groups" },
  { mode: "selected", label: "Chosen people and groups" },
];
const SHARE_HINTS = {
  off: "Only you see your timeline.",
  groups: "Everyone who shares a group with you can open your days in their timeline.",
  selected: "The people you pick, and everyone in the groups you pick, can open your days in their timeline.",
};
let sharing = null;

const sharingOpen = () => !modal.hidden && modalTitle.textContent === SHARING_TITLE;

// Everybody who shares a group with me, once each, by name.
function sharePeople() {
  const people = new Map();
  for (const group of groups) {
    for (const member of group.members) if (member.id !== me?.id && !people.has(member.id)) people.set(member.id, member);
  }
  const name = (user) => user.displayName || user.username;
  return [...people.values()].sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: "base" }));
}

function renderSharing() {
  const users = new Set(sharing.users);
  const groupIds = new Set(sharing.groups);
  const chip = (attr, id, label, on) => `<button class="chip" type="button" ${attr}="${id}" aria-pressed="${on}">${label}</button>`;
  const modes = SHARE_MODES.map((m) => chip("data-share-mode", m.mode, esc(m.label), sharing.mode === m.mode)).join("");
  const people = sharePeople();
  const picks =
    sharing.mode !== "selected"
      ? ""
      : groups.length || people.length
        ? `${groups.length ? `<p class="gsection">Groups</p><div class="chips share__chips">${groups.map((g) => chip("data-share-group", g.id, esc(g.name), groupIds.has(g.id))).join("")}</div>` : ""}
           ${people.length ? `<p class="gsection">People</p><div class="chips share__chips">${people.map((p) => chip("data-share-user", p.id, personName(p), users.has(p.id))).join("")}</div>` : ""}`
        : '<p class="hint share__note">Nobody shares a group with you yet.</p>';
  modalBody.innerHTML = `
    <div class="chips share__chips share__modes" role="group" aria-label="Who sees your timeline">${modes}</div>
    ${picks}
    <p class="hint share__note">${esc(SHARE_HINTS[sharing.mode])} Nobody else can change it, and while you are invisible it shows nothing to them. The admin sees every timeline.</p>
    <p class="form-error share__note" role="alert"></p>`;
}

async function saveSharing(next) {
  const previous = sharing;
  sharing = next;
  renderSharing();
  try {
    sharing = await call("/api/timeline/sharing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (sharingOpen()) renderSharing();
  } catch (error) {
    if (error.message === "signed-out") return;
    sharing = previous;
    if (!sharingOpen()) return;
    renderSharing();
    modalBody.querySelector(".form-error").textContent = error.message || "Could not save, try again.";
  }
}

const flip = (list, id, on) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));

modalBody.addEventListener("click", (event) => {
  if (!sharingOpen() || !sharing) return;
  const chip = event.target.closest("[data-share-mode], [data-share-group], [data-share-user]");
  if (!chip) return;
  const on = chip.getAttribute("aria-pressed") !== "true";
  if (chip.dataset.shareMode !== undefined) {
    if (chip.dataset.shareMode !== sharing.mode) saveSharing({ ...sharing, mode: chip.dataset.shareMode });
  } else if (chip.dataset.shareGroup !== undefined) {
    saveSharing({ ...sharing, groups: flip(sharing.groups, Number(chip.dataset.shareGroup), on) });
  } else {
    saveSharing({ ...sharing, users: flip(sharing.users, Number(chip.dataset.shareUser), on) });
  }
});

async function showSharing() {
  openModal(SHARING_TITLE);
  note('<div class="spinner"></div>');
  try {
    const [settings] = await Promise.all([call("/api/timeline/sharing"), refreshGroups()]);
    if (!sharingOpen()) return;
    sharing = settings;
    renderSharing();
  } catch (error) {
    if (error.message !== "signed-out" && sharingOpen()) note(`<strong>Could not load the sharing</strong>${esc(error.message)}`);
  }
}

document.getElementById("openSharing").addEventListener("click", () => {
  setMenu(false);
  showSharing();
});

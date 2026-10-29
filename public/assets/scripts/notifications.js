// The bell in the HUD: who joined with an invite code, who arrived somewhere or left.
const bellButton = document.getElementById("bellButton");
const bellBadge = document.getElementById("bellBadge");

let notifications = [];
// The ones that were unread when the panel opened stay highlighted until it closes.
let freshIds = new Set();

const notificationsOpen = () => !modal.hidden && modalTitle.textContent === "Notifications";
const unreadCount = () => notifications.filter((n) => !n.readAt).length;

function updateBell() {
  const unread = unreadCount();
  bellBadge.hidden = unread === 0;
  bellBadge.textContent = unread > 99 ? "99+" : String(unread);
  bellButton.setAttribute("aria-label", unread ? `Notifications, ${unread} unread` : "Notifications");
}

// The person of an arrival from the groups, for the picture; their name from then otherwise.
function presencePerson({ userId, name }) {
  for (const group of groups) {
    const member = group.members.find((m) => m.id === userId);
    if (member) return member;
  }
  return { id: userId, username: name, displayName: name, avatarUrl: null };
}

function notificationText(item) {
  if (item.type === "arrived" || item.type === "left") {
    const { name, placeName, at } = item.data;
    const clock = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return {
      user: presencePerson(item.data),
      title: `${esc(name)} ${item.type === "arrived" ? "arrived at" : "left"} ${esc(placeName)}`,
      meta: `${esc(clock)} · ${esc(timeAgo(item.createdAt))}`,
    };
  }
  const { user, invitedBy, groupName } = item.data;
  return {
    user,
    title: `${personName(user)} joined with ${esc(invitedBy.displayName || invitedBy.username)}'s invite code`,
    meta: `${groupName ? `${esc(groupName)} · ` : ""}${esc(timeAgo(item.createdAt))}`,
  };
}

function notificationRow(item) {
  const { user, title, meta } = notificationText(item);
  return `
    <li class="row notice${freshIds.has(item.id) || !item.readAt ? " is-unread" : ""}">
      ${accountAvatarHtml(user, "sm")}
      <span class="row__text">
        <strong>${title}</strong>
        <span>${meta}</span>
      </span>
    </li>`;
}

function renderNotifications() {
  const unread = unreadCount();
  modalBody.innerHTML = notifications.length
    ? `${unread ? '<div class="row__edit-actions notice-actions"><button class="btn btn--small btn--ghost" type="button" data-read-all>Mark all read</button></div>' : ""}
       <ul class="rows">${notifications.map(notificationRow).join("")}</ul>`
    : '<div class="tl-note"><span class="empty__icon"><svg class="icon"><use href="#i-bell" /></svg></span><strong>Nothing new</strong>You hear here about new accounts that join with your invite codes, and when people arrive at or leave their places.</div>';
}

async function markAllRead() {
  if (unreadCount() === 0) return;
  try {
    await call("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch {
    return;
  }
  const stamp = new Date().toISOString();
  for (const item of notifications) item.readAt ??= stamp;
  updateBell();
  if (notificationsOpen()) renderNotifications();
}

async function refreshNotifications() {
  try {
    notifications = await call("/api/notifications");
  } catch {
    return;
  }
  bellButton.hidden = false;
  updateBell();
  if (notificationsOpen()) {
    for (const item of notifications) if (!item.readAt) freshIds.add(item.id);
    renderNotifications();
  }
}

function showNotifications() {
  freshIds = new Set(notifications.filter((n) => !n.readAt).map((n) => n.id));
  openModal("Notifications");
  renderNotifications();
  markAllRead();
}

bellButton.addEventListener("click", showNotifications);
modalBody.addEventListener("click", (event) => {
  if (notificationsOpen() && event.target.closest("[data-read-all]")) markAllRead();
});

document.addEventListener("notificationschanged", refreshNotifications);
window.addEventListener("focus", refreshNotifications);
bellButton.hidden = true;
refreshNotifications();

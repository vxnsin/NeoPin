// Who is signed in, and the account's profile picture.
const AVATAR_SIZE = 128;
const AVATAR_MAX_BYTES = 16 * 1024;

const accountWrap = document.getElementById("accountWrap");
const accountButton = document.getElementById("accountButton");
const accountMenu = document.getElementById("accountMenu");
const avatarFile = document.getElementById("avatarFile");
const avatarRemove = document.getElementById("avatarRemove");
const avatarUpload = document.getElementById("avatarUpload");

let me = null;

function accountAvatarHtml(user, size) {
  const inner = user.avatarUrl
    ? `<img src="${esc(user.avatarUrl)}" alt="" decoding="async" />`
    : `<span>${esc(initials(user.displayName || user.username))}</span>`;
  return `<span class="avatar avatar--account avatar--${size} ${colourClass(user.username)}">${inner}</span>`;
}

function renderAccount() {
  if (!me) return;
  const name = me.displayName || me.username;
  document.getElementById("accountAvatar").innerHTML = accountAvatarHtml(me, "sm");
  document.getElementById("accountAvatarLg").innerHTML = accountAvatarHtml(me, "lg");
  document.getElementById("accountName").textContent = name;
  document.getElementById("accountNameLg").textContent = name;
  document.getElementById("accountUsername").textContent = `@${me.username}`;
  accountButton.setAttribute("aria-label", `Account: ${name}`);
  avatarRemove.hidden = !me.avatarUrl;
  document.getElementById("openAccounts").hidden = !me.isAdmin;
  document.getElementById("pwBanner").hidden = !me.mustChangePassword;
  accountWrap.hidden = false;
}

function setMenu(open) {
  accountMenu.hidden = !open;
  accountButton.setAttribute("aria-expanded", String(open));
}

accountButton.addEventListener("click", () => setMenu(accountMenu.hidden));
document.addEventListener("click", (event) => {
  if (!accountMenu.hidden && !accountWrap.contains(event.target)) setMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !accountMenu.hidden) {
    setMenu(false);
    accountButton.focus();
  }
});

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable"));
    };
    image.src = url;
  });
}

// Centre crop to a square, then lower the quality until it fits the server's limit.
async function squareJpeg(file) {
  const image = await loadImage(file);
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE
  );
  for (let quality = 0.9; quality >= 0.3; quality -= 0.1) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= AVATAR_MAX_BYTES) return blob;
  }
  throw new Error("too-large");
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("signed-out");
  }
  return response;
}

avatarUpload.addEventListener("click", () => avatarFile.click());

avatarFile.addEventListener("change", async () => {
  const file = avatarFile.files[0];
  avatarFile.value = "";
  if (!file) return;
  setMenu(false);
  try {
    const blob = await squareJpeg(file);
    const response = await request("/api/avatar", { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
    if (!response.ok) throw new Error("rejected");
    me.avatarUrl = (await response.json()).avatarUrl;
    renderAccount();
    toast("Profile picture updated.");
  } catch (error) {
    if (error.message === "signed-out") return;
    toast(error.message === "unreadable" ? "That file is not a picture." : "The picture could not be saved.");
  }
});

avatarRemove.addEventListener("click", async () => {
  setMenu(false);
  try {
    const response = await request("/api/avatar", { method: "DELETE" });
    if (!response.ok) throw new Error("rejected");
    me.avatarUrl = null;
    renderAccount();
    toast("Profile picture removed.");
  } catch (error) {
    if (error.message !== "signed-out") toast("The picture could not be removed.");
  }
});

accountWrap.hidden = true;
const meReady = fetch("/api/me")
  .then((response) => (response.ok ? response.json() : null))
  .then((user) => {
    if (!user) return;
    me = user;
    renderAccount();
    render();
  })
  .catch(() => {});

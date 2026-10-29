// The first visit: a new server walks its admin through the first steps, then everybody gets a
// short tour of the dashboard once. The server remembers both (GET /api/me).
const setupEl = document.getElementById("setup");
const setupTitle = document.getElementById("setupTitle");
const setupSteps = document.getElementById("setupSteps");
const setupBody = document.getElementById("setupBody");
const tourEl = document.getElementById("tour");
const tourSpot = document.getElementById("tourSpot");
const tourDim = document.getElementById("tourDim");
const tourCard = document.getElementById("tourCard");

const postJson = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// The map has to be there before anything points at it.
function pageReady() {
  const loader = document.getElementById("loader");
  if (loader.classList.contains("is-hidden")) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!loader.classList.contains("is-hidden")) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(loader, { attributes: true, attributeFilter: ["class"] });
    // A map that never loads must not keep the setup away.
    setTimeout(() => {
      observer.disconnect();
      resolve();
    }, 8000);
  });
}

// Setup (admin, new server). It cannot be closed: without a group nobody would see anybody.

const setup = { steps: [], index: 0, group: null, groups: [], invites: true, added: false };

async function startSetup() {
  const [mine, status] = await Promise.all([call("/api/groups").catch(() => []), fetch("/api/status").then((r) => r.json()).catch(() => ({}))]);
  setup.groups = mine;
  setup.invites = status.invites !== false;
  // Back after a reload halfway through: a group made then counts.
  setup.group = mine[0] ?? null;
  setup.steps = [...(me.mustChangePassword ? ["password"] : []), ...(setup.group ? [] : ["group"]), "person"];
  setup.index = 0;
  setupEl.hidden = false;
  renderSetup();
}

function renderSetup() {
  const step = setup.steps[setup.index];
  // Back after a reload only the last step may be left: "Step 1 of 1" would read odd.
  setupSteps.textContent = setup.steps.length === 1 ? "Last step" : `Step ${setup.index + 1} of ${setup.steps.length}`;
  if (step === "password") renderPasswordStep();
  else if (step === "group") renderGroupStep();
  else renderPersonStep();
  setupBody.querySelector("input")?.focus();
}

function nextSetupStep() {
  setup.index += 1;
  if (setup.index < setup.steps.length) renderSetup();
  else finishSetup();
}

function renderPasswordStep() {
  setupTitle.textContent = "Choose your password";
  setupBody.innerHTML = `
    <form class="setup__form" novalidate>
      <p class="setup__lead">Welcome to your NeoPin server. You signed in with the password it generated, pick one of your own first.</p>
      <input class="select" name="current" type="password" placeholder="Current password" autocomplete="current-password" aria-label="Current password" />
      <input class="select" name="next" type="password" placeholder="New password (8+ characters)" autocomplete="new-password" aria-label="New password" />
      <input class="select" name="again" type="password" placeholder="Repeat the new password" autocomplete="new-password" aria-label="Repeat the new password" />
      <p class="form-error" role="alert"></p>
      <div class="setup__actions"><button class="btn" type="submit">Save password</button></div>
    </form>`;
  const form = setupBody.querySelector("form");
  const error = form.querySelector(".form-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.current.value) return (error.textContent = "Enter the current password.");
    if (form.next.value.length < 8) return (error.textContent = "The new password needs at least 8 characters.");
    if (form.next.value !== form.again.value) return (error.textContent = "The new passwords do not match.");
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    error.textContent = "";
    // Not call(): a wrong current password answers 401 too, and that is no reason to sign out.
    try {
      const response = await fetch("/api/me/password", postJson({ currentPassword: form.current.value, newPassword: form.next.value }));
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        error.textContent = response.status === 401 && !body.detail ? "The current password is not right." : body.detail || "The password could not be changed.";
        submit.disabled = false;
        return;
      }
      me.mustChangePassword = false;
      renderAccount();
      nextSetupStep();
    } catch {
      error.textContent = "The server is not reachable.";
      submit.disabled = false;
    }
  });
}

function renderGroupStep() {
  setupTitle.textContent = "Create your first group";
  setupBody.innerHTML = `
    <form class="setup__form" novalidate>
      <p class="setup__lead">Groups decide who sees whom: everyone in a group sees the others on the map. Start with one, more can follow any time.</p>
      <input class="select" name="name" placeholder="Group name, e.g. Family" maxlength="40" autocomplete="off" aria-label="Group name" />
      <p class="form-error" role="alert"></p>
      <div class="setup__actions"><button class="btn" type="submit">Create group</button></div>
    </form>`;
  const form = setupBody.querySelector("form");
  const error = form.querySelector(".form-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = form.name.value.trim();
    if (!name) return (error.textContent = "The group needs a name.");
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    error.textContent = "";
    try {
      setup.group = await call("/api/groups", postJson({ name }));
      setup.groups = [...setup.groups, setup.group];
      refreshGroups();
      nextSetupStep();
    } catch (failure) {
      if (failure.message === "signed-out") return;
      error.textContent = failure.message;
      submit.disabled = false;
    }
  });
}

// An account made here, or an invite code for the group. Both can wait ("Later").
function renderPersonStep(mode = "account") {
  setupTitle.textContent = "Add the first person";
  const tabs = setup.invites
    ? `<div class="chips setup__tabs" role="group" aria-label="How to add them">
        <button class="chip" type="button" data-mode="account" aria-pressed="${mode === "account"}">Create an account</button>
        <button class="chip" type="button" data-mode="invite" aria-pressed="${mode === "invite"}">Send an invite code</button>
      </div>`
    : "";
  const account = `
    <form class="setup__form" data-account novalidate>
      <input class="select" name="username" placeholder="Username" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Username" />
      <input class="select" name="displayName" placeholder="Display name (optional)" maxlength="64" autocomplete="off" aria-label="Display name" />
      <input class="select" name="password" type="password" placeholder="Start password (8+ characters)" autocomplete="new-password" aria-label="Start password" />
      ${groupPickerHtml(setup.groups, [setup.group.id])}
      <p class="hint">They sign in to the NeoPin app with it and can change the password there.</p>
      <p class="form-error" role="alert"></p>
      <div class="setup__actions">
        <button class="btn btn--ghost" type="button" data-later>Later</button>
        <button class="btn" type="submit">Create account</button>
      </div>
    </form>`;
  const invite = `
    <div class="setup__form" data-invite>
      <p class="hint">A code lets one person create their own account. They join ${esc(setup.group.name)} right away.</p>
      <div class="invite-new" data-code hidden></div>
      <p class="form-error" role="alert"></p>
      <div class="setup__actions">
        <button class="btn btn--ghost" type="button" data-later>Later</button>
        <button class="btn" type="button" data-make-code>Create invite code</button>
      </div>
    </div>`;
  setupBody.innerHTML = `
    <p class="setup__lead">Who should see you on the map? Create an account for someone, or send them a code to sign up themselves.</p>
    ${tabs}
    ${mode === "account" ? account : invite}`;

  setupBody.querySelectorAll("[data-mode]").forEach((tab) => tab.addEventListener("click", () => renderPersonStep(tab.dataset.mode)));
  setupBody.querySelectorAll("[data-later]").forEach((button) => button.addEventListener("click", finishSetup));

  const form = setupBody.querySelector("[data-account]");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = form.querySelector(".form-error");
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    error.textContent = "";
    try {
      const user = await call(
        "/api/users",
        postJson({
          username: form.username.value.trim(),
          password: form.password.value,
          ...(form.displayName.value.trim() && { displayName: form.displayName.value.trim() }),
          groupIds: pickedGroups(form),
        })
      );
      refreshGroups();
      added(`${esc(user.displayName)} can sign in to the NeoPin app as <strong>@${esc(user.username)}</strong> now.`);
    } catch (failure) {
      if (failure.message === "signed-out") return;
      error.textContent = failure.message;
      submit.disabled = false;
    }
  });

  setupBody.querySelector("[data-make-code]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const box = setupBody.querySelector("[data-invite]");
    const error = box.querySelector(".form-error");
    button.disabled = true;
    error.textContent = "";
    try {
      const code = await call("/api/invite-codes", postJson({ groupId: setup.group.id }));
      const link = inviteLink(code.code);
      const shown = box.querySelector("[data-code]");
      shown.innerHTML = `
        <span class="invite-new__label">Invite code</span>
        <strong class="invite-new__code">${esc(code.code)}</strong>
        <span class="hint setup__link">${esc(link)}</span>
        <div class="row__edit-actions"><button class="btn btn--small" type="button" data-copy>Copy link</button></div>`;
      shown.hidden = false;
      shown.querySelector("[data-copy]").addEventListener("click", async () => {
        toast((await copyText(link)) ? "Link copied." : "Could not copy, select it by hand.");
      });
      button.remove();
      box.querySelector("[data-later]").textContent = "Finish";
      box.querySelector("[data-later]").classList.remove("btn--ghost");
    } catch (failure) {
      if (failure.message === "signed-out") return;
      error.textContent = failure.message;
      button.disabled = false;
    }
  });
}

function added(html) {
  setupBody.innerHTML = `
    <div class="setup__form">
      <p class="setup__lead">${html}</p>
      <div class="setup__actions"><button class="btn" type="button" data-finish>Finish</button></div>
    </div>`;
  const finish = setupBody.querySelector("[data-finish]");
  finish.addEventListener("click", finishSetup);
  finish.focus();
}

async function finishSetup() {
  try {
    await call("/api/setup/done", { method: "POST" });
  } catch (failure) {
    if (failure.message !== "signed-out") toast(failure.message);
    return;
  }
  me.setupNeeded = false;
  setupEl.hidden = true;
  setupBody.replaceChildren();
  if (me.tours?.dashboard === false) startTour();
}

// Tour: one control at a time, lit up where it really is, with a few words on what it does.
// Steps whose control is not on the page (a hidden entry, a narrow screen) are left out.

const TOUR_STEPS = [
  { target: "#devicesPanel", title: "People", text: "Everyone you share a group with, and their devices. Click a person to find them on the map." },
  { target: "#groupChips", title: "Group chips", text: "Show the people of one group only, or All. The pick is kept in this browser." },
  { target: ".hud-stat", title: "Online", text: "How many of the devices you see are online right now." },
  { target: "#bellButton", title: "Notifications", text: "Arrivals and departures from arrival alerts, and people who signed up with your invite codes." },
  { target: "#accountButton", title: "Account menu", text: "Your account and everything around it. The next steps walk through its entries." },
  { target: "#openDevices", menu: true, title: "My devices", text: "The phones signed in to your account. Unlink one you no longer use." },
  { target: "#openGroups", menu: true, title: "Groups", text: "Groups decide who sees whom. Create one, invite people by username, accept invitations." },
  { target: "#openInvites", menu: true, title: "Invite codes", text: "A code or link lets one person create their own account, straight into a group if you like." },
  { target: "#openAccounts", menu: true, admin: true, title: "Accounts", text: "As the admin you create, edit and remove accounts here. A new account can go straight into groups." },
  { target: "#openArrivals", menu: true, title: "Arrival alerts", text: "Tell the people you pick when you arrive at or leave your places." },
  { target: "#openHide", menu: true, title: "Invisible", text: "Gone from everyone else's map for a while. Your own map and timeline go on." },
  { target: "#openSharing", menu: true, title: "Share my timeline", text: "Nobody sees your timeline unless you share it: with your groups, or with the people you pick." },
  { target: "#openProfile", menu: true, title: "Edit profile", text: "Your display name and the username you sign in with." },
  { target: "#openPassword", menu: true, title: "Change password", text: "A new password for this account." },
  { target: "#avatarUpload", menu: true, title: "Profile picture", text: "The picture the others see next to your name." },
  { target: "#timelineButton", title: "Timeline", text: "Where a device has been, day by day: places, trips and the lines taken." },
  { target: "#refreshButton", title: "Refresh", text: "Asks every device for a fresh position." },
  { target: "[data-theme-toggle]", title: "Light or dark", text: "Switches the dashboard between light and dark." },
];

const tour = { all: [], current: null };

// On the page and drawn: not inside anything hidden, and with a box of its own.
const shown = (el) => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0;
const tourTarget = (step) => document.querySelector(step.target);

// Which steps have their control on the page right now. Asked at every step, because some
// controls turn up late (the bell, invite codes) or go away with the screen width. The menu
// entries only count while the menu is open, so it is open for the check.
function liveSteps() {
  const closed = accountMenu.hidden;
  accountMenu.hidden = false;
  const live = tour.all.filter((s) => shown(tourTarget(s)));
  accountMenu.hidden = closed;
  return live;
}

function startTour() {
  tour.all = TOUR_STEPS.filter((s) => !s.admin || me.isAdmin);
  tour.current = tour.all[0];
  tourEl.hidden = false;
  moveTour(0);
}

// 0 stays on the current step (or the next one there is), 1 goes on, -1 goes back.
function moveTour(delta) {
  const live = liveSteps();
  const pos = tour.all.indexOf(tour.current);
  const ahead = live.filter((s) => tour.all.indexOf(s) > (delta === 0 ? pos - 1 : pos));
  const step = delta < 0 ? live.filter((s) => tour.all.indexOf(s) < pos).pop() : ahead[0];
  if (!step) return delta < 0 ? undefined : endTour();
  tour.current = step;
  const index = live.indexOf(step);
  setMenu(!!step.menu);
  document.getElementById("tourCount").textContent = `${index + 1} / ${live.length}`;
  document.getElementById("tourTitle").textContent = step.title;
  document.getElementById("tourText").textContent = step.text;
  document.getElementById("tourBack").hidden = index === 0;
  document.getElementById("tourNext").textContent = index === live.length - 1 ? "Done" : "Next";
  placeTour();
  document.getElementById("tourNext").focus();
}

// A rounded rectangle as an SVG path, the hole in the dimmed page.
function roundedRect(x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

// The light sits on the target, the card goes below or above it, whichever has room.
function placeTour() {
  if (tourEl.hidden) return;
  const target = tourTarget(tour.current);
  const gutter = 16;
  const pad = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Measured again on every resize: a control can move, or go away on a narrow screen.
  const r = shown(target) ? target.getBoundingClientRect() : null;
  if (!r) {
    tourSpot.hidden = true;
    tourDim.setAttribute("d", `M0 0H${vw}V${vh}H0Z`);
    tourCard.style.left = `${Math.max(gutter, (vw - tourCard.offsetWidth) / 2)}px`;
    tourCard.style.top = `${Math.max(gutter, (vh - tourCard.offsetHeight) / 2)}px`;
    return;
  }
  const top = Math.max(r.top - pad, 4);
  const bottom = Math.min(r.bottom + pad, vh - 4);
  const left = Math.max(r.left - pad, 4);
  const right = Math.min(r.right + pad, vw - 4);
  tourSpot.hidden = false;
  Object.assign(tourSpot.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  tourDim.setAttribute("d", `M0 0H${vw}V${vh}H0Z ${roundedRect(left, top, right - left, bottom - top, 12)}`);
  const w = tourCard.offsetWidth;
  const h = tourCard.offsetHeight;
  const gap = 12;
  let y;
  if (vh - bottom >= h + gap + gutter) y = bottom + gap;
  else if (top >= h + gap + gutter) y = top - gap - h;
  else y = vh - h - gutter;
  const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, gutter), vw - w - gutter);
  tourCard.style.left = `${x}px`;
  tourCard.style.top = `${Math.max(gutter, y)}px`;
}

function endTour() {
  tourEl.hidden = true;
  setMenu(false);
  me.tours = { ...me.tours, dashboard: true };
  call("/api/me/tours", postJson({ client: "dashboard" })).catch(() => {});
}

document.getElementById("tourNext").addEventListener("click", () => moveTour(1));
document.getElementById("tourBack").addEventListener("click", () => moveTour(-1));
document.getElementById("tourSkip").addEventListener("click", endTour);
// Clicks stay in the tour, so the account menu it opened does not close behind its back.
tourEl.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !tourEl.hidden) {
    event.stopImmediatePropagation();
    endTour();
  }
}, true);
// A control that went away with the new size hands over to the next one that is there.
window.addEventListener("resize", () => {
  if (!tourEl.hidden) shown(tourTarget(tour.current)) ? placeTour() : moveTour(0);
});

meReady
  .then(async () => {
    if (!me) return;
    await pageReady();
    if (me.isAdmin && me.setupNeeded) startSetup();
    else if (me.tours?.dashboard === false) startTour();
  })
  .catch(() => {});

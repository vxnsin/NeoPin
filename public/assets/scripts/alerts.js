// Arrival alerts: which of your own places tell others when you arrive or leave, and who hears
// about it, people and whole groups. Saved on every change, like the switches in the app.
const ARRIVALS_TITLE = "Arrival alerts";
const arrivals = { settings: null, places: [] };

const arrivalsOpen = () => !modal.hidden && modalTitle.textContent === ARRIVALS_TITLE;

// Everybody who shares a group with you, once each, by name.
function alertPeople() {
  const people = new Map();
  for (const group of groups) {
    for (const member of group.members) if (member.id !== me?.id && !people.has(member.id)) people.set(member.id, member);
  }
  const name = (user) => user.displayName || user.username;
  return [...people.values()].sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: "base" }));
}

const placeIcon = (kind) => (kind === "home" || kind === "work" ? `#i-${kind}` : "#i-place");

function renderArrivals() {
  const { settings, places } = arrivals;
  const chosen = new Set(settings.places);
  const users = new Set(settings.recipients.users);
  const groupIds = new Set(settings.recipients.groups);
  const placeRows = places.length
    ? `<ul class="rows">${places
        .map(
          (place) => `
          <li class="row">
            <span class="row__icon"><svg class="icon"><use href="${placeIcon(place.kind)}" /></svg></span>
            <span class="row__text"><strong>${esc(place.name)}</strong><span>${esc(KIND_LABELS[place.kind] ?? "Place")}</span></span>
            <label class="switch">
              <input type="checkbox" role="switch" data-place="${place.id}"${chosen.has(place.id) ? " checked" : ""} aria-label="${esc(`Alerts for ${place.name}`)}" />
              <span class="switch__track" aria-hidden="true"></span>
            </label>
          </li>`
        )
        .join("")}</ul>`
    : '<p class="hint arrivals__note">No places yet. Mark a stop in the timeline as Home or Work and it shows up here.</p>';
  const people = alertPeople();
  const groupChips = groups
    .map((g) => `<button class="chip" type="button" data-alert-group="${g.id}" aria-pressed="${groupIds.has(g.id)}">${esc(g.name)}</button>`)
    .join("");
  const personChips = people
    .map(
      (p) =>
        `<button class="chip chip--person" type="button" data-alert-user="${p.id}" aria-pressed="${users.has(p.id)}">${accountAvatarHtml(p, "xs")}${personName(p)}</button>`
    )
    .join("");
  modalBody.innerHTML = `
    <p class="gsection">Places</p>
    ${placeRows}
    <p class="gsection">Who hears about it</p>
    ${
      groups.length || people.length
        ? `${groupChips ? `<div class="chips chips--wrap" aria-label="Groups">${groupChips}</div>` : ""}
           ${personChips ? `<div class="chips chips--wrap" aria-label="People">${personChips}</div>` : ""}`
        : '<p class="hint arrivals__note">Nobody shares a group with you yet.</p>'
    }
    <p class="hint arrivals__note">They get a notification when you arrive at or leave a place that is on. A whole group includes whoever joins it later. Nothing goes out while you are invisible.</p>
    <p class="form-error arrivals__note" role="alert"></p>`;
}

async function saveArrivals(next) {
  const previous = arrivals.settings;
  arrivals.settings = next;
  renderArrivals();
  try {
    arrivals.settings = await call("/api/alerts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (arrivalsOpen()) renderArrivals();
  } catch (error) {
    if (error.message === "signed-out") return;
    arrivals.settings = previous;
    if (!arrivalsOpen()) return;
    renderArrivals();
    modalBody.querySelector(".form-error").textContent = error.message || "Could not save, try again.";
  }
}

const toggled = (list, id, on) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));

modalBody.addEventListener("change", (event) => {
  const input = event.target.closest("[data-place]");
  if (!arrivalsOpen() || !input || !arrivals.settings) return;
  saveArrivals({ ...arrivals.settings, places: toggled(arrivals.settings.places, Number(input.dataset.place), input.checked) });
});

modalBody.addEventListener("click", (event) => {
  if (!arrivalsOpen() || !arrivals.settings) return;
  const chip = event.target.closest("[data-alert-group], [data-alert-user]");
  if (!chip) return;
  const on = chip.getAttribute("aria-pressed") !== "true";
  const { recipients } = arrivals.settings;
  const next =
    chip.dataset.alertGroup !== undefined
      ? { ...recipients, groups: toggled(recipients.groups, Number(chip.dataset.alertGroup), on) }
      : { ...recipients, users: toggled(recipients.users, Number(chip.dataset.alertUser), on) };
  saveArrivals({ ...arrivals.settings, recipients: next });
});

async function showArrivals() {
  openModal(ARRIVALS_TITLE);
  note('<div class="spinner"></div>');
  try {
    const [settings, places] = await Promise.all([call("/api/alerts"), call("/api/places"), refreshGroups()]);
    if (!arrivalsOpen()) return;
    arrivals.settings = settings;
    arrivals.places = places;
    renderArrivals();
  } catch (error) {
    if (error.message !== "signed-out" && arrivalsOpen()) note(`<strong>Could not load the alerts</strong>${esc(error.message)}`);
  }
}

document.getElementById("openArrivals").addEventListener("click", () => {
  setMenu(false);
  showArrivals();
});

// Diagnostics exports the preview app uploaded, for the admin: who sent which, download, delete.
// Each one runs out a week after the upload by itself (see src/diagnostics.js).
const diagnosticsDialogOpen = () => !modal.hidden && modalTitle.textContent === "Diagnostics";

function diagnosticsRow(item) {
  const time = (iso) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const who = item.deviceId ? `${item.username} · ${item.deviceId}` : item.username;
  return `
    <li class="row" data-diagnostics="${esc(item.id)}">
      <span class="row__icon"><svg class="icon"><use href="#i-phone" /></svg></span>
      <span class="row__text">
        <strong>${esc(who)}</strong>
        <span>${esc(time(item.createdAt))} · ${esc(sizeText(item.size))} · until ${esc(time(item.expiresAt))}</span>
      </span>
      <a class="btn btn--small btn--ghost" href="/diagnostics/${encodeURIComponent(item.id)}.zip" download>Download</a>
      <button class="btn btn--small btn--ghost" type="button" data-delete-diagnostics>Delete</button>
    </li>`;
}

function renderDiagnostics(list) {
  modalBody.innerHTML = `
    <p class="hint">Exports from the preview app's developer settings: its own log of fixes, connections, battery and errors, without exact positions. Anyone with a link can download it until it expires, a week after the upload.</p>
    ${
      list.length
        ? `<ul class="rows">${list.map(diagnosticsRow).join("")}</ul>`
        : '<div class="tl-note"><strong>None right now</strong>The preview app uploads one with Export diagnostics in its settings, unless DIAGNOSTICS=off.</div>'
    }`;
}

async function showDiagnostics() {
  openModal("Diagnostics");
  note('<div class="spinner"></div>');
  try {
    const list = await call("/api/admin/diagnostics");
    if (diagnosticsDialogOpen()) renderDiagnostics(list);
  } catch (error) {
    if (error.message !== "signed-out") note(`<strong>Could not load the exports</strong>${esc(error.message)}`);
  }
}

modalBody.addEventListener("click", (event) => {
  if (!diagnosticsDialogOpen()) return;
  const button = event.target.closest("[data-delete-diagnostics]");
  if (!button) return;
  const row = button.closest("[data-diagnostics]");
  confirmRemove(button, "Delete this export?", async () => {
    await call(`/api/admin/diagnostics/${encodeURIComponent(row.dataset.diagnostics)}`, { method: "DELETE" });
    if (diagnosticsDialogOpen()) showDiagnostics();
  });
});

document.getElementById("openDiagnostics").addEventListener("click", () => {
  setMenu(false);
  showDiagnostics();
});

meReady.then(() => {
  document.getElementById("openDiagnostics").hidden = !me?.isAdmin;
});

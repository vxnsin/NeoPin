// Backups, for the admin: download one now, the nightly ones, and restoring from a file.
const backupDialogOpen = () => !modal.hidden && modalTitle.textContent === "Backups";
const restoreFile = document.createElement("input");
restoreFile.type = "file";
restoreFile.accept = ".db,application/octet-stream";
restoreFile.hidden = true;
document.body.append(restoreFile);

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function backupRow(backup) {
  const when = new Date(backup.createdAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `
    <li class="row">
      <span class="row__icon"><svg class="icon"><use href="#i-database" /></svg></span>
      <span class="row__text">
        <strong>${esc(backup.name)}</strong>
        <span>${esc(when)} · ${esc(sizeText(backup.size))}</span>
      </span>
      <a class="btn btn--small btn--ghost" href="/api/admin/backups/${encodeURIComponent(backup.name)}" download>Download</a>
    </li>`;
}

function renderBackups(list) {
  modalBody.innerHTML = `
    <div class="backup">
      <p class="hint">A copy of the database: accounts, groups, places and the whole location history. Timetables are left out, the server downloads them again by itself.</p>
      <a class="btn backup__download" href="/api/admin/backup" download data-download-now><svg class="icon"><use href="#i-download" /></svg>Download backup now</a>
    </div>
    <h3 class="gsection">Automatic backups</h3>
    ${
      list.length
        ? `<ul class="rows">${list.map(backupRow).join("")}</ul>`
        : '<div class="tl-note"><strong>None yet</strong>The server writes one every night at 03:30 into backups/ next to the database, unless BACKUPS=off.</div>'
    }
    <h3 class="gsection">Restore</h3>
    <div class="backup">
      <div class="warning" role="note">
        <svg class="icon"><use href="#i-alert" /></svg>
        <span>Restoring replaces every account, group, place and the whole history with the backup. Whatever happened since it was made is gone. The current database is kept next to it as <code>neopin.db.before-restore</code>.</span>
      </div>
      <div class="row backup__restore">
        <span class="row__text"><span data-restore-file>Pick a NeoPin backup (.db).</span></span>
        <button class="btn btn--small btn--danger" type="button" data-restore>Restore from file</button>
      </div>
      <p class="form-error" role="alert" data-restore-error></p>
    </div>`;
}

async function showBackups() {
  openModal("Backups");
  note('<div class="spinner"></div>');
  try {
    const list = await call("/api/admin/backups");
    if (backupDialogOpen()) renderBackups(list);
  } catch (error) {
    if (error.message !== "signed-out") note(`<strong>Could not load the backups</strong>${esc(error.message)}`);
  }
}

modalBody.addEventListener("click", (event) => {
  if (!backupDialogOpen()) return;
  // Copying a large database takes a moment before the download starts.
  if (event.target.closest("[data-download-now]")) toast("Preparing the backup…");
  if (event.target.closest("[data-restore]")) restoreFile.click();
});

restoreFile.addEventListener("change", () => {
  const file = restoreFile.files[0];
  restoreFile.value = "";
  if (!file || !backupDialogOpen()) return;
  const button = modalBody.querySelector("[data-restore]");
  const error = modalBody.querySelector("[data-restore-error]");
  error.textContent = "";
  modalBody.querySelector("[data-restore-file]").textContent = `${file.name} · ${sizeText(file.size)}`;
  // Asked again in place, it cannot be undone from the dashboard.
  confirmRemove(button, "Replace the database with this file?", async () => {
    await call("/api/admin/restore", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file }).catch((failure) => {
      if (failure.message === "signed-out") throw failure;
      error.textContent = failure.message;
      // confirmRemove brings the button back.
      throw new Error("The backup was not accepted.");
    });
    if (!backupDialogOpen()) return;
    note(
      '<span class="empty__icon"><svg class="icon"><use href="#i-database" /></svg></span><strong>Backup uploaded</strong>Restart the server to finish.'
    );
  });
});

document.getElementById("openBackups").addEventListener("click", () => {
  setMenu(false);
  showBackups();
});

meReady.then(() => {
  document.getElementById("openBackups").hidden = !me?.isAdmin;
});

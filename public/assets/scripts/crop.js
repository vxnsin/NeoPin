// Crop dialog for the profile picture: drag, wheel, pinch or keys to frame it, Save renders the square.
const CROP_VIEW = 280;
const CROP_MAX_ZOOM = 5;
// 256 px looks better on big screens, 128 px is the fallback when the file gets too heavy.
const CROP_OUTPUTS = [256, 128];

// Resolves with a JPEG blob of at most AVATAR_MAX_BYTES, or null when the user cancels.
async function cropAvatar(file) {
  const image = await loadImage(file);
  const iw = image.naturalWidth;
  const ih = image.naturalHeight;

  return new Promise((resolve) => {
    openModal("Crop picture");
    modalBody.innerHTML = `
      <div class="cropper">
        <div class="cropper__view">
          <canvas class="cropper__canvas" tabindex="0" role="application" aria-label="Picture position. Arrow keys move it, plus and minus zoom."></canvas>
          <span class="cropper__mask" aria-hidden="true"></span>
        </div>
        <label class="cropper__zoom">
          <span>Zoom</span>
          <input type="range" min="1" max="${CROP_MAX_ZOOM}" step="0.01" value="1" aria-label="Zoom" />
        </label>
        <p class="hint">Drag to move, scroll or pinch to zoom.</p>
        <div class="row__edit-actions">
          <button class="btn btn--small btn--ghost" type="button" data-cancel>Cancel</button>
          <button class="btn btn--small" type="button" data-save>Save</button>
        </div>
      </div>`;

    const view = Math.min(CROP_VIEW, modalBody.clientWidth - 32);
    const viewEl = modalBody.querySelector(".cropper__view");
    viewEl.style.width = viewEl.style.height = `${view}px`;
    const canvas = modalBody.querySelector("canvas");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.height = Math.round(view * dpr);
    canvas.style.width = canvas.style.height = `${view}px`;
    const context = canvas.getContext("2d");
    const slider = modalBody.querySelector("input[type=range]");

    // The image always covers the whole square: scale >= minScale, offsets keep the edges outside.
    const minScale = view / Math.min(iw, ih);
    let zoom = 1;
    let x = (view - iw * minScale) / 2;
    let y = (view - ih * minScale) / 2;

    function clamp() {
      const scale = minScale * zoom;
      x = Math.min(0, Math.max(view - iw * scale, x));
      y = Math.min(0, Math.max(view - ih * scale, y));
    }

    function draw() {
      const scale = minScale * zoom;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, view, view);
      context.imageSmoothingQuality = "high";
      context.drawImage(image, x, y, iw * scale, ih * scale);
    }

    // Zoom around a point of the square so what is under the finger stays there.
    function zoomAt(next, px = view / 2, py = view / 2) {
      next = Math.min(CROP_MAX_ZOOM, Math.max(1, next));
      const before = minScale * zoom;
      const after = minScale * next;
      x = px - ((px - x) / before) * after;
      y = py - ((py - y) / before) * after;
      zoom = next;
      slider.value = String(zoom);
      clamp();
      draw();
    }

    function moveBy(dx, dy) {
      x += dx;
      y += dy;
      clamp();
      draw();
    }

    const local = (event) => {
      const box = canvas.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };

    const pointers = new Map();
    let pinch = null;
    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, local(event));
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom };
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      const [px, py] = local(event);
      const [ox, oy] = pointers.get(event.pointerId);
      pointers.set(event.pointerId, [px, py]);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
        zoomAt(pinch.zoom * (distance / pinch.distance), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      } else if (pointers.size === 1) {
        moveBy(px - ox, py - oy);
      }
    });
    const release = (event) => {
      pointers.delete(event.pointerId);
      pinch = null;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const [px, py] = local(event);
        zoomAt(zoom * Math.exp(-event.deltaY * 0.0015), px, py);
      },
      { passive: false }
    );

    canvas.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 40 : 10;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[event.key]) moveBy(...moves[event.key]);
      else if (event.key === "+" || event.key === "=") zoomAt(zoom * 1.1);
      else if (event.key === "-" || event.key === "_") zoomAt(zoom / 1.1);
      else return;
      event.preventDefault();
    });
    slider.addEventListener("input", () => zoomAt(Number(slider.value)));

    // The square that is visible, in image pixels.
    async function render() {
      const scale = minScale * zoom;
      const source = [-x / scale, -y / scale, view / scale, view / scale];
      for (const size of CROP_OUTPUTS) {
        const out = document.createElement("canvas");
        out.width = out.height = size;
        const c = out.getContext("2d");
        c.fillStyle = "#ffffff";
        c.fillRect(0, 0, size, size);
        c.imageSmoothingQuality = "high";
        c.drawImage(image, ...source, 0, 0, size, size);
        for (let quality = 0.9; quality >= 0.3; quality -= 0.1) {
          const blob = await new Promise((done) => out.toBlob(done, "image/jpeg", quality));
          if (blob && blob.size <= AVATAR_MAX_BYTES) return blob;
        }
      }
      return null;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modalCleanup = null;
      resolve(value);
    };
    // Closing with the X, Escape or a click outside counts as Cancel.
    modalCleanup = () => finish(null);

    modalBody.querySelector("[data-cancel]").addEventListener("click", () => {
      closeModal();
    });
    modalBody.querySelector("[data-save]").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      const blob = await render();
      modalCleanup = null;
      closeModal();
      if (blob) finish(blob);
      else {
        toast("The picture could not be made small enough.");
        finish(null);
      }
    });

    draw();
    canvas.focus();
  });
}

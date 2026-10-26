// Device markers pop up on the background map now and then, like phones reporting in.
const BLIP_COLORS = ["#d3171e", "#22c55e", "#2563eb", "#7c3aed", "#ea580c", "#0284c7", "#db2777"];
const backdrop = document.getElementById("backdrop");

function blip() {
  if (document.hidden || backdrop.childElementCount > 9) return;
  const x = 4 + Math.random() * 92;
  const y = 6 + Math.random() * 88;
  // Keep the middle free, the card sits there.
  if (x > 33 && x < 67 && y > 22 && y < 78) return;
  const el = document.createElement("span");
  el.className = Math.random() < 0.3 ? "blip blip--large" : "blip";
  el.style.left = `${x}%`;
  el.style.top = `${y}%`;
  el.style.setProperty("--blip", BLIP_COLORS[Math.floor(Math.random() * BLIP_COLORS.length)]);
  backdrop.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  for (let i = 0; i < 4; i++) setTimeout(blip, i * 250);
  setInterval(blip, 700);
}

const form = document.getElementById("loginForm");
const input = document.getElementById("password");
const field = input.closest(".field");
const toggle = document.getElementById("togglePassword");
const submit = document.getElementById("submit");
const message = document.getElementById("message");

function showError(text) {
  message.textContent = text;
  // Take the marker off and back on, so the shake plays on every wrong try.
  field.removeAttribute("data-invalid");
  void field.offsetWidth;
  field.setAttribute("data-invalid", "");
  input.select();
}

toggle.addEventListener("click", () => {
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  toggle.setAttribute("aria-pressed", String(show));
  toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
  toggle.querySelector("use").setAttribute("href", show ? "#i-eye-off" : "#i-eye");
  input.focus();
});

input.addEventListener("input", () => {
  field.removeAttribute("data-invalid");
  message.textContent = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!input.value) return showError("Enter the server password.");

  submit.disabled = true;
  submit.classList.add("is-busy");
  message.textContent = "";
  try {
    const response = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value }),
    });
    if (response.ok) {
      window.location.href = "/";
      return;
    }
    if (response.status === 401) showError("That password is not right.");
    else if (response.status === 429) showError("Too many attempts. Wait a minute and try again.");
    else showError("The server could not sign you in. Try again.");
  } catch {
    showError("The server is not reachable.");
  } finally {
    submit.disabled = false;
    submit.classList.remove("is-busy");
  }
});

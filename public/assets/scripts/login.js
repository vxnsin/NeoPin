// The background flies over a town in the dark. Now and then a device pings,
// lights up the streets around it for a moment and travels along with the ground.
const PING_COLORS = ["#d3171e", "#22c55e", "#2563eb", "#7c3aed", "#ea580c", "#0284c7", "#db2777"];
const SPEED = 110; // ground pixels per second
const LIGHT_RADIUS = 320; // half the size of .spot__light
const plane = document.getElementById("plane");
const pings = document.createElement("div");
pings.style.position = "absolute";
pings.style.inset = "0";
plane.appendChild(pings);
let offset = { x: 0, y: 0 };

function ping() {
  if (!document.hidden && pings.childElementCount < 5) {
    // Spots on the tilted ground that show left and right of the card, not under it.
    const left = Math.random() < 0.5;
    const x = ((left ? 36 + Math.random() * 7 : 57 + Math.random() * 15) / 100) * plane.offsetWidth - offset.x;
    const y = ((18 + Math.random() * 28) / 100) * plane.offsetHeight - offset.y;

    const spot = document.createElement("span");
    spot.className = "spot";
    spot.style.left = `${x}px`;
    spot.style.top = `${y}px`;
    spot.style.setProperty("--ping", PING_COLORS[Math.floor(Math.random() * PING_COLORS.length)]);
    const light = document.createElement("span");
    light.className = "spot__light";
    // Spot and ground move together, so this lines its streets up with the ground's for good.
    light.style.backgroundPosition = `${LIGHT_RADIUS - x}px ${LIGHT_RADIUS - y}px`;
    const dot = document.createElement("span");
    dot.className = "ping";
    spot.append(light, dot);
    pings.appendChild(spot);
    setTimeout(() => spot.remove(), 5200);
  }
  setTimeout(ping, 1100 + Math.random() * 1600);
}

// The heading swings slowly, so the flight never runs over the same streets in the same way.
function fly(previous) {
  return (now) => {
    const seconds = Math.min(0.1, (now - previous) / 1000);
    const heading = 0.3 + 0.7 * Math.sin(now / 21000) + 0.25 * Math.sin(now / 7300);
    offset = {
      x: offset.x + Math.sin(heading) * SPEED * seconds,
      y: offset.y + Math.cos(heading) * SPEED * seconds,
    };
    plane.style.backgroundPosition = `${offset.x}px ${offset.y}px`;
    pings.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
    requestAnimationFrame(fly(now));
  };
}

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  requestAnimationFrame(fly(performance.now()));
  setTimeout(ping, 400);
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

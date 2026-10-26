// The background flies over a town in the dark. Now and then a device pings,
// lights up the streets around it for a moment and travels along with the ground.
const PING_COLORS = ["#d3171e", "#22c55e", "#2563eb", "#7c3aed", "#ea580c", "#0284c7", "#db2777"];
const SPEED = 110; // ground pixels per second
const LIGHT_RADIUS = 320; // half the size of .spot__light
const TILE = { width: 1600, height: 1000 }; // town.svg
const plane = document.getElementById("plane");
const ground = document.getElementById("ground");
const pings = document.createElement("div");
pings.style.position = "absolute";
pings.style.inset = "0";
pings.style.willChange = "transform";
plane.appendChild(pings);
let offset = { x: 0, y: 0 };

// Shifting by whole tiles changes nothing on screen, so the ground only ever moves less than one.
const wrap = (value, size) => ((value % size) + size) % size;

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
    ground.style.transform = `translate3d(${wrap(offset.x, TILE.width)}px, ${wrap(offset.y, TILE.height)}px, 0)`;
    pings.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
    requestAnimationFrame(fly(now));
  };
}

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  requestAnimationFrame(fly(performance.now()));
  setTimeout(ping, 400);
}

const form = document.getElementById("loginForm");
const usernameInput = document.getElementById("username");
const input = document.getElementById("password");
const toggle = document.getElementById("togglePassword");
const submit = document.getElementById("submit");
const message = document.getElementById("message");

function showError(text, target = input) {
  message.textContent = text;
  const field = target.closest(".field");
  // Take the marker off and back on, so the shake plays on every wrong try.
  field.removeAttribute("data-invalid");
  void field.offsetWidth;
  field.setAttribute("data-invalid", "");
  target.focus();
  target.select();
}

function clearError() {
  message.textContent = "";
  for (const field of form.querySelectorAll("[data-invalid]")) field.removeAttribute("data-invalid");
}

toggle.addEventListener("click", () => {
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  toggle.setAttribute("aria-pressed", String(show));
  toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
  toggle.querySelector("use").setAttribute("href", show ? "#i-eye-off" : "#i-eye");
  input.focus();
});

form.addEventListener("input", clearError);

async function problemText(response, fallback) {
  try {
    const data = await response.json();
    return data.message || data.detail || data.title || fallback;
  } catch {
    return fallback;
  }
}

async function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  if (!username) return showError("Enter your username.", usernameInput);
  if (!input.value) return showError("Enter your password.");

  submit.disabled = true;
  submit.classList.add("is-busy");
  message.textContent = "";
  try {
    const response = await post("/login", { username, password: input.value });
    if (response.ok) {
      window.location.href = "/";
      return;
    }
    if (response.status === 401) showError("Username or password is not right.");
    else if (response.status === 429) showError("Too many attempts. Wait a minute and try again.");
    else showError(await problemText(response, "The server could not sign you in. Try again."));
  } catch {
    showError("The server is not reachable.");
  } finally {
    submit.disabled = false;
    submit.classList.remove("is-busy");
  }
});

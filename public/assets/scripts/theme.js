// Loaded in <head> so the page paints in the right theme from the first frame.
// The theme follows the system until someone picks one with the toggle.
(() => {
  const KEY = "neopin-theme";
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");

  const stored = () => {
    try {
      const value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch {
      return null;
    }
  };

  const apply = (theme) => {
    if (root.dataset.theme === theme) return;
    root.dataset.theme = theme;
    root.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
  };

  apply(stored() ?? (system.matches ? "dark" : "light"));
  system.addEventListener("change", (event) => {
    if (!stored()) apply(event.matches ? "dark" : "light");
  });

  window.neopinTheme = {
    get: () => root.dataset.theme,
    toggle() {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Private windows may refuse storage, the switch still works for this page.
      }
      apply(next);
    },
  };

  document.addEventListener("DOMContentLoaded", () => {
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.addEventListener("click", () => window.neopinTheme.toggle());
    }
  });
})();

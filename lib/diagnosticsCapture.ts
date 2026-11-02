import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { AppState, Platform } from "react-native";
import { logError, logEvent, safeString, setDiagnosticsEnabled } from "@/lib/diagnostics";
import { isDeveloperBuild } from "@/lib/updates";

// Turns the diagnostics log on in preview and development builds and hooks in what is logged
// globally: app start, foreground and background, uncaught errors, console warnings and errors.
// Imported once from lib/socket, which the app and both background tasks load.

let installed = false;

const consoleText = (args: unknown[]) =>
  args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : safeString(a))).join(" ");

export function installDiagnostics() {
  if (installed || !isDeveloperBuild()) return;
  installed = true;
  setDiagnosticsEnabled(true);

  logEvent("start", {
    platform: Platform.OS,
    version: Constants.expoConfig?.version ?? null,
    channel: Updates.channel ?? null,
    runtime: Updates.runtimeVersion ?? null,
    update: Updates.updateId ? Updates.updateId.slice(0, 8) : "built-in",
    appState: AppState.currentState,
  });
  AppState.addEventListener("change", (state) => logEvent("app", { state }));

  const errorUtils = (globalThis as any).ErrorUtils;
  if (errorUtils?.getGlobalHandler && errorUtils?.setGlobalHandler) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      logError(isFatal ? "fatal" : "uncaught", error);
      previous?.(error, isFatal);
    });
  }

  // Our own logging must not log itself again when something in it warns.
  let inside = false;
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (!inside) {
        inside = true;
        try {
          if (level === "error") logError("console", consoleText(args));
          else logEvent("warn", { src: "console", msg: consoleText(args) });
        } finally {
          inside = false;
        }
      }
      original(...args);
    };
  }
}

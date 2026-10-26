import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Alert } from "react-native";

export type UpdateResult = "ready" | "current" | "unavailable" | "failed";

let prompted = false;

// Checks for a new over-the-air version and downloads it. Applying it needs a restart, which the
// user decides on (see promptRestart).
export async function checkForUpdate(): Promise<UpdateResult> {
  if (__DEV__ || !Updates.isEnabled) return "unavailable";
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return "current";
    await Updates.fetchUpdateAsync();
    return "ready";
  } catch {
    return "failed";
  }
}

// Tells the user a new version is downloaded and offers the restart. Asks once per app start,
// the manual check in the settings can ask again.
export function promptRestart(force = false) {
  if (prompted && !force) return;
  prompted = true;
  Alert.alert("Update available", "A new version of NeoPin is ready. Restart the app to use it.", [
    { text: "Later", style: "cancel" },
    { text: "Restart", onPress: () => Updates.reloadAsync().catch(() => {}) },
  ]);
}

export async function checkAndPrompt(force = false): Promise<UpdateResult> {
  const result = await checkForUpdate();
  if (result === "ready") promptRestart(force);
  return result;
}

// "v1.0.2 · preview · 60ac4d5f", or null in Expo Go and development builds. The version comes
// from the running update's config, so it moves with every published update.
export function updateLabel(): string | null {
  if (!Updates.isEnabled) return null;
  const id = Updates.updateId;
  const where = Updates.channel ?? "";
  const version = Constants.expoConfig?.version;
  return [version ? `v${version}` : null, where || null, id ? id.slice(0, 8) : "built-in"].filter(Boolean).join(" · ");
}

import Constants from "expo-constants";
import * as Updates from "expo-updates";

export type UpdateResult = "applied" | "current" | "unavailable" | "failed";

// Over-the-air updates: expo-updates only downloads at launch and uses the new version on the
// launch after that. Fetching and reloading right away makes the first launch enough.
export async function checkAndApplyUpdate(): Promise<UpdateResult> {
  if (__DEV__ || !Updates.isEnabled) return "unavailable";
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return "current";
    await Updates.fetchUpdateAsync();
    await Updates.reloadAsync();
    return "applied";
  } catch {
    return "failed";
  }
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

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

// "preview · 60ac4d5f", or null in Expo Go and development builds.
export function updateLabel(): string | null {
  if (!Updates.isEnabled) return null;
  const id = Updates.updateId;
  const where = Updates.channel ?? "";
  return `${where}${where ? " · " : ""}${id ? id.slice(0, 8) : "built-in"}`;
}

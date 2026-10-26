import AsyncStorage from "@react-native-async-storage/async-storage";
import type { User } from "@/lib/api";

// "userData" held the shared server password. It is only read to be wiped.
export const LEGACY_KEY = "userData";
export const SESSION_KEY = "session";

export type StoredCredentials = {
  serverIp: string;
  deviceId: string;
  token: string;
  user: User;
};

// Keeps only what a valid session needs. Anything else, including the old
// password-style record, is no session.
export function parseSession(raw: string | null): StoredCredentials | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || "password" in value) return null;
    const { serverIp, deviceId, token, user } = value;
    if (typeof serverIp !== "string" || !serverIp || typeof deviceId !== "string" || !deviceId) return null;
    if (typeof token !== "string" || !token) return null;
    if (!user || typeof user.id !== "number" || typeof user.username !== "string") return null;
    return {
      serverIp,
      deviceId,
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: typeof user.displayName === "string" ? user.displayName : user.username,
        avatarUrl: typeof user.avatarUrl === "string" ? user.avatarUrl : null,
      },
    };
  } catch {
    return null;
  }
}

type Store = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

const asyncStore: Store = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};

// The token goes into the Keychain / Keystore through expo-secure-store. A build
// without the native module (an older dev client) falls back to AsyncStorage.
function loadSecureStore(): Store {
  try {
    const SecureStore = require("expo-secure-store");
    if (typeof SecureStore.getItemAsync !== "function") return asyncStore;
    return {
      get: (key) => SecureStore.getItemAsync(key),
      set: (key, value) => SecureStore.setItemAsync(key, value),
      remove: (key) => SecureStore.deleteItemAsync(key),
    };
  } catch {
    return asyncStore;
  }
}

let store: Store | null = null;
function secure(): Store {
  return (store ??= loadSecureStore());
}

export async function readCredentials(): Promise<StoredCredentials | null> {
  try {
    // A stored password must not outlive the update.
    if (await AsyncStorage.getItem(LEGACY_KEY)) await AsyncStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore
  }
  let raw: string | null;
  try {
    raw = await secure().get(SESSION_KEY);
  } catch {
    // The Keychain can be unavailable for a moment (device locked), try again next time.
    return null;
  }
  const session = parseSession(raw);
  // An unreadable record is dropped, so the next start does not trip over it again.
  if (raw && !session) await secure().remove(SESSION_KEY).catch(() => {});
  return session;
}

export async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  await secure().set(SESSION_KEY, JSON.stringify(credentials));
}

export async function updateStoredUser(user: User): Promise<void> {
  const current = await readCredentials();
  if (current) await saveCredentials({ ...current, user });
}

export async function clearCredentials(): Promise<void> {
  await Promise.all([
    secure().remove(SESSION_KEY).catch(() => {}),
    AsyncStorage.removeItem(LEGACY_KEY).catch(() => {}),
  ]);
}

import AsyncStorage from "@react-native-async-storage/async-storage";
import { httpBase, markTourSeen, type DeviceAuth, type User } from "@/lib/api";

// The short walk through the map after the first login. The server remembers it per account
// (`tours.app`); older servers do not, there it is once per device.

export type TourTarget = "map" | "people" | "timeline" | "settings";

export type TourStep = {
  key: string;
  icon: "map" | "people" | "near-me" | "timeline" | "group-add" | "where-to-vote" | "battery-charging-full" | "dashboard";
  title: string;
  text: string;
  // Where the step points. "map" lights up nothing, the whole map is the subject.
  target: TourTarget;
};

const STEPS: TourStep[] = [
  {
    key: "map",
    icon: "map",
    title: "Your map",
    text: "Everyone you share a group with shows up here with their picture. The red dot is you.",
    target: "map",
  },
  {
    key: "people",
    icon: "near-me",
    title: "People and Find",
    text: "Tap People for the list. Tap a person to jump to them, or the arrow to start Find and walk to each other.",
    target: "people",
  },
  {
    key: "timeline",
    icon: "timeline",
    title: "Timeline",
    text: "Where you were and how you got there, day by day.",
    target: "timeline",
  },
  {
    key: "groups",
    icon: "group-add",
    title: "Groups and invite codes",
    text: "In the settings. Groups decide who sees whom; an invite code brings someone new onto the server.",
    target: "settings",
  },
  {
    key: "alerts",
    icon: "where-to-vote",
    title: "Alerts and sharing",
    text: "Also there: tell others when you arrive at your places, and pick who may see your timeline.",
    target: "settings",
  },
  {
    key: "battery",
    icon: "battery-charging-full",
    title: "Battery",
    text: "Position updates sets how often your phone reports. Battery saver lasts longest.",
    target: "settings",
  },
];

const ADMIN_STEP: TourStep = {
  key: "dashboard",
  icon: "dashboard",
  title: "The dashboard",
  text: "Accounts and server setup are in the dashboard, in the browser at your server's address.",
  target: "map",
};

export function tourSteps(isAdmin: boolean): TourStep[] {
  return isAdmin ? [...STEPS, ADMIN_STEP] : STEPS;
}

// What this device remembers: seen on an older server (once per device), and the accounts it was
// seen with when telling the server failed.
export type LocalTour = { device: boolean; accounts: string[] };

const KEY = "tour.app";

export const accountKey = (auth: Pick<DeviceAuth, "serverIp">, userId: number) => `${httpBase(auth.serverIp)}#${userId}`;

export async function loadLocalTour(): Promise<LocalTour> {
  try {
    const value = JSON.parse((await AsyncStorage.getItem(KEY)) ?? "null");
    return {
      device: value?.device === true,
      accounts: Array.isArray(value?.accounts) ? value.accounts.filter((a: unknown) => typeof a === "string") : [],
    };
  } catch {
    return { device: false, accounts: [] };
  }
}

async function saveLocalTour(local: LocalTour): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(local));
  } catch {
    // best effort
  }
}

// Seen already? The server's word counts when it has one; a server without `tours` leaves it to the
// device. Seen here while the server could not be told also counts, so it does not come back.
export function tourSeen(me: Pick<User, "tours">, local: LocalTour, account: string): boolean {
  if (me.tours && typeof me.tours.app === "boolean") return me.tours.app || local.accounts.includes(account);
  return local.device;
}

// Only on the map itself: nothing in front of it, the start screen gone, the timeline closed.
export function tourMayOpen(state: { mapReady: boolean; sheetOpen: boolean; cropOpen: boolean; timelineOpen: boolean }): boolean {
  return state.mapReady && !state.sheetOpen && !state.cropOpen && !state.timelineOpen;
}

// Done or skipped: the server is told, and the device remembers it when the server cannot be
// (an older one answers 404, or it is out of reach).
export async function finishTour(auth: DeviceAuth, userId: number): Promise<"server" | "device"> {
  try {
    if (await markTourSeen(auth, "app")) return "server";
  } catch {
    // fall back below
  }
  const local = await loadLocalTour();
  const account = accountKey(auth, userId);
  await saveLocalTour({ device: true, accounts: local.accounts.includes(account) ? local.accounts : [...local.accounts, account] });
  return "device";
}

// The hint for an admin whose server still waits for its first group.
export function showSetupBanner(me: Pick<User, "isAdmin" | "setupNeeded">, dismissed: boolean): boolean {
  return me.isAdmin === true && me.setupNeeded === true && !dismissed;
}

export const dashboardUrl = (serverIp: string) => httpBase(serverIp);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { httpBase, markTourSeen, type DeviceAuth, type User } from "@/lib/api";

// The short walk through the app after the first login: one step per control, each pointing at
// the control itself. The server remembers it per account (`tours.app`); older servers do not,
// there it is once per device.

// The controls a step can point at. Each is measured where it really is on the screen.
export type TourTarget =
  | "peopleBar"
  | "timelineButton"
  | "settingsButton"
  | "groupChips"
  | "personRow"
  | "findButton"
  | "refreshButton"
  | "profile"
  | "groupsEntry"
  | "alertsEntry"
  | "inviteCodesEntry"
  | "presets"
  | "sharingEntry";

// Which sheet has to be open for the control: none (the map), the people list or the settings.
export type TourSheet = "devices" | "settings" | null;

export type TourStep = {
  key: string;
  icon:
    | "map"
    | "people"
    | "timeline"
    | "settings"
    | "filter-list"
    | "person"
    | "near-me"
    | "refresh"
    | "account-circle"
    | "group"
    | "where-to-vote"
    | "vpn-key"
    | "battery-charging-full"
    | "dashboard";
  title: string;
  text: string;
  sheet: TourSheet;
  // null: nothing to point at, the card sits in the middle. A control that is not on the screen
  // right now (no second group, nobody online to find) falls back to that too.
  target: TourTarget | null;
};

const STEPS: TourStep[] = [
  { key: "map", icon: "map", title: "Your map", text: "Everyone you share a group with shows up with their picture. The red dot is you.", sheet: null, target: null },
  { key: "people", icon: "people", title: "People", text: "Tap the bar for everyone and their devices.", sheet: null, target: "peopleBar" },
  { key: "timeline", icon: "timeline", title: "Timeline", text: "Where you were and how you got there, day by day.", sheet: null, target: "timelineButton" },
  { key: "settings", icon: "settings", title: "Settings", text: "Your profile, groups, alerts and more.", sheet: null, target: "settingsButton" },
  { key: "chips", icon: "filter-list", title: "Group chips", text: "Pick a group to see only its people. All shows everyone.", sheet: "devices", target: "groupChips" },
  { key: "person", icon: "person", title: "A person", text: "Tap to jump to them on the map and see their devices.", sheet: "devices", target: "personRow" },
  { key: "find", icon: "near-me", title: "Find", text: "The arrow next to someone online walks you to each other.", sheet: "devices", target: "findButton" },
  { key: "refresh", icon: "refresh", title: "Refresh", text: "Asks every device for a fresh position.", sheet: "devices", target: "refreshButton" },
  { key: "profile", icon: "account-circle", title: "You", text: "Tap your picture to change it, Edit profile for your name.", sheet: "settings", target: "profile" },
  { key: "groups", icon: "group", title: "Groups", text: "Make groups and invite people. Groups decide who sees whom.", sheet: "settings", target: "groupsEntry" },
  { key: "alerts", icon: "where-to-vote", title: "Arrival alerts", text: "Tell people when you arrive at or leave your places.", sheet: "settings", target: "alertsEntry" },
  { key: "codes", icon: "vpn-key", title: "Invite codes", text: "A code brings someone new onto the server.", sheet: "settings", target: "inviteCodesEntry" },
  { key: "battery", icon: "battery-charging-full", title: "Battery", text: "How often your phone reports. Battery saver lasts longest.", sheet: "settings", target: "presets" },
  { key: "sharing", icon: "timeline", title: "Share my timeline", text: "Pick who may see where you were.", sheet: "settings", target: "sharingEntry" },
];

const ADMIN_STEP: TourStep = {
  key: "dashboard",
  icon: "dashboard",
  title: "The dashboard",
  text: "Accounts and server setup are in the dashboard, in the browser.",
  sheet: null,
  target: null,
};

export function tourSteps(isAdmin: boolean): TourStep[] {
  return isAdmin ? [...STEPS, ADMIN_STEP] : STEPS;
}

export type Rect = { x: number; y: number; width: number; height: number };

// A control counts as on screen when all of it is inside the visible area.
export function onScreen(rect: Rect, view: Rect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= view.x &&
    rect.y >= view.y &&
    rect.x + rect.width <= view.x + view.width &&
    rect.y + rect.height <= view.y + view.height
  );
}

// How far a list has to scroll so a control below the fold lands a little above the middle of
// the screen, where the card still fits next to it. Never above the top of the list.
export function scrollToShow(rect: Rect, screenHeight: number, offset: number): number {
  return Math.max(0, offset + rect.y - Math.round(screenHeight * 0.4));
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

// A sheet the tour did not open (a find request, a ride question) ends it for now; it starts
// again once the map is free.
export function tourInterrupted(sheet: string | null): boolean {
  return sheet !== null && sheet !== "devices" && sheet !== "settings";
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

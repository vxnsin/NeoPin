import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { fetchServerStatus, registerPushToken, removePushToken, type DeviceAuth } from "@/lib/api";
import { needsRegistration, parsePushAction, type StoredPush } from "@/lib/pushPayload";
import { requestSheet } from "@/lib/sheetRequest";
import { socket } from "@/lib/socket";
import { handlePush } from "@/tasks/PushTask";

const STORED_KEY = "neopin.pushRegistration";
const CHANNEL_ID = "default";

// Messages with a title are shown, also in front. A silent wake-up never is.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // With the socket up the request already arrives as a dialog, a banner would say it twice.
    if (parsePushAction(notification)?.type === "findRequest" && socket.connected) {
      return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
    }
    const show = !!notification.request.content.title || !!notification.request.content.body;
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: false, shouldSetBadge: false };
  },
});

async function readStored(): Promise<StoredPush | null> {
  try {
    const raw = await AsyncStorage.getItem(STORED_KEY);
    return raw ? (JSON.parse(raw) as StoredPush) : null;
  } catch {
    return null;
  }
}

// Push is Android only for now, and only with a build that has the Firebase config. Anything missing
// (no config, no Play services, an older server) just means no push, never an error for the user.
async function nativeToken(): Promise<string | null> {
  if (Platform.OS !== "android") return null;
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    return typeof token.data === "string" && token.data ? token.data : null;
  } catch {
    return null;
  }
}

async function register(auth: DeviceAuth, token: string) {
  const current: StoredPush = { token, serverIp: auth.serverIp, deviceId: auth.deviceId, auth: auth.token };
  if (!needsRegistration(await readStored(), current)) return;
  try {
    const status = await fetchServerStatus(auth.serverIp);
    if (status.push !== true) return;
    await registerPushToken(auth, token, "android");
    await AsyncStorage.setItem(STORED_KEY, JSON.stringify(current));
  } catch {
    // Offline or the server does not know push: tried again with the next connection.
  }
}

// Keeps this device's token on the server for as long as the app is connected. Returns the cleanup.
export function startPush(auth: DeviceAuth): () => void {
  if (Platform.OS !== "android") return () => {};
  let active = true;

  Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "NeoPin",
    importance: Notifications.AndroidImportance.HIGH,
  }).catch(() => {});

  nativeToken().then((token) => {
    if (active && token) register(auth, token);
  });
  const tokens = Notifications.addPushTokenListener((token) => {
    if (active && typeof token.data === "string" && token.data) register(auth, token.data);
  });
  // A wake-up while the app is open. The background task covers the other cases.
  const received = Notifications.addNotificationReceivedListener((notification) => {
    handlePush(notification).catch(() => {});
  });

  return () => {
    active = false;
    tokens.remove();
    received.remove();
  };
}

// Takes the token off the server, best effort, and forgets that it was registered.
export async function stopPush(auth: DeviceAuth | null) {
  await AsyncStorage.removeItem(STORED_KEY).catch(() => {});
  if (!auth || Platform.OS !== "android") return;
  await removePushToken(auth).catch(() => {});
}

// What a tap on a notification should open, or null when it is not one of ours.
export type NotificationTarget = "map" | "connect";

// An invitation goes to the groups sheet, a used invite code to the notifications. A find request goes to the map, where the dialog shows once the
// socket replays the request; without a connection the start screen has to connect first.
export function openFromNotification(response: Notifications.NotificationResponse): NotificationTarget | null {
  const action = parsePushAction(response);
  if (action?.type === "groupInvite") {
    requestSheet("groups");
    return "map";
  }
  if (action?.type === "inviteUsed") {
    requestSheet("notifications");
    return "map";
  }
  if (action?.type === "findRequest") return socket.connected ? "map" : "connect";
  return null;
}

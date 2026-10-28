import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import * as Location from "expo-location";
import { Platform } from "react-native";
import { toFix } from "@/lib/fixes";
import { createDedupe, parsePushAction } from "@/lib/pushPayload";
import { reportFixes } from "@/tasks/LocationTask";

export const PUSH_TASK = "neopin-push-wakeup";

// The wake-up has to report within the few seconds Android gives a push, so each step is capped.
const POSITION_TIMEOUT_MS = 7_000;

const firstTime = createDedupe();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

async function currentPosition(): Promise<Location.LocationObject | null> {
  const fresh = await withTimeout(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    POSITION_TIMEOUT_MS
  );
  if (fresh) return fresh;
  return Location.getLastKnownPositionAsync().catch(() => null);
}

// Reports the position when the message asks for it. Used by the background task and the foreground
// listener, the same wake-up is only answered once.
export async function handlePush(payload: unknown): Promise<void> {
  const action = parsePushAction(payload);
  if (action?.type !== "requestLocation" || !firstTime(action.id)) return;
  const permission = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (permission?.status !== "granted") return;
  const position = await currentPosition();
  if (position) await reportFixes([toFix(position)]);
}

// Defined at module level so it exists when Android starts the JS without the app (data-only push).
TaskManager.defineTask(PUSH_TASK, async ({ data, error }) => {
  if (error) return;
  try {
    await handlePush(data);
  } catch (err: any) {
    console.warn("Push wake-up failed:", err?.message);
  }
});

if (Platform.OS === "android") {
  Notifications.registerTaskAsync(PUSH_TASK).catch((err) => console.warn("Push task unavailable:", err?.message));
}

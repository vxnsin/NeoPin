import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { answerRide } from "@/lib/api";
import { readCredentials } from "@/lib/credentials";
import { dataOf } from "@/lib/pushPayload";
import { answerOnce, firstAsk, offerRide, rememberAnswer, showRide, wasAnswered } from "@/lib/rideInbox";
import {
  RIDE_CATEGORY,
  RIDE_NO,
  RIDE_YES,
  isStaleRide,
  parseRideQuestion,
  rideQuestionDetail,
  rideResponseOf,
  rideQuestionText,
  stampRide,
  type RideAnswer,
  type RideQuestion,
} from "@/lib/rides";

// The channel lib/push.ts sets up; Android keeps it once it exists, also for the background task.
const CHANNEL_ID = "default";

const notificationId = (rideId: string) => `ride.${rideId}`;

// Yes and No answer without opening the app: Android hands the button to the background task
// (expo-notifications runs registered tasks for action buttons while the app is not in front).
// False when the category could not be registered; the notification then goes out without buttons.
let category: Promise<boolean> | null = null;
function rideCategory(): Promise<boolean> {
  category ??= Notifications.setNotificationCategoryAsync(RIDE_CATEGORY, [
    { identifier: RIDE_YES, buttonTitle: "Yes", options: { opensAppToForeground: false } },
    { identifier: RIDE_NO, buttonTitle: "No", options: { opensAppToForeground: false } },
  ]).then(
    () => true,
    () => {
      category = null;
      return false;
    }
  );
  return category;
}

// The question travels in the notification's data, so a tap or a button brings it back whole.
const rideData = (question: RideQuestion) => ({
  type: "rideQuestion",
  rideId: question.rideId,
  transit: question.transit,
  at: question.at,
  ...(question.seenAt !== undefined ? { seenAt: question.seenAt } : {}),
});

async function present(question: RideQuestion, failed = false) {
  const buttons = !failed && (await rideCategory());
  await Notifications.scheduleNotificationAsync({
    identifier: notificationId(question.rideId),
    content: failed
      ? { title: "Your answer did not get through", body: `${rideQuestionText(question)} Tap to answer in NeoPin.`, data: rideData(question) }
      : {
          title: rideQuestionText(question),
          body: buttons ? rideQuestionDetail(question) : `${rideQuestionDetail(question)} Tap to answer.`,
          data: rideData(question),
          ...(buttons ? { categoryIdentifier: RIDE_CATEGORY } : {}),
        },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
  });
}

const dismiss = (rideId: string) => Notifications.dismissNotificationAsync(notificationId(rideId)).catch(() => {});

// Sends the answer and takes the notification away. Throws when the server could not be reached, the
// answer may then be given again; a later answer replaces an earlier one. A ride the server no longer
// knows (404) is over: nothing to retry, the question just goes away.
export function sendRideAnswer(question: RideQuestion, answer: RideAnswer): Promise<void> {
  return answerOnce(question.rideId, answer, async () => {
    const creds = await readCredentials();
    if (!creds) throw new Error("Not signed in.");
    try {
      await answerRide(creds, question.rideId, answer);
    } catch (error: any) {
      if (error?.status !== 404) throw error;
    }
    await rememberAnswer(question.rideId);
    await dismiss(question.rideId);
  });
}

// A button on the notification. Without the app in front a failed answer leaves a notification
// that opens the app, where the question can be answered again.
async function answerFromButton(question: RideQuestion, answer: RideAnswer) {
  try {
    await sendRideAnswer(question, answer);
  } catch {
    if (AppState.currentState === "active") showRide(question);
    else await present(question, true).catch(() => {});
  }
}

// From lib/push.ts when a ride notification is tapped or answered with the app running. A button is
// answered where the user is ("answered"); a tap opens the question on the map ("shown"), unless the
// question is too old by now ("stale").
export function openRideResponse(payload: unknown): "answered" | "shown" | "stale" | null {
  const response = rideResponseOf(payload);
  if (!response) return null;
  const { question, answer } = response;
  if (answer) {
    answerFromButton(question, answer);
    return "answered";
  }
  if (isStaleRide(question, Date.now())) {
    dismiss(question.rideId);
    return "stale";
  }
  wasAnswered(question.rideId).then((done) => {
    if (!done) showRide(question);
  });
  return "shown";
}

// Asks a ride once, whichever way it came (socket, push, push task): as the sheet with the app in front,
// as a notification with Yes and No on Android otherwise. iPhones keep it for the map until the app is back.
// A question older than 15 minutes is not asked.
export async function askRide(input: RideQuestion): Promise<void> {
  const now = Date.now();
  const question = stampRide(input, now);
  if (isStaleRide(question, now)) return;
  if (AppState.currentState === "active" || Platform.OS !== "android") await offerRide(question, now);
  else if (await firstAsk(question.rideId)) await present(question).catch(() => {});
}

// From the push task and the foreground listener. A button pressed in the background is answered here.
// True when the push was about a ride.
export async function handleRidePush(payload: unknown): Promise<boolean> {
  const response = rideResponseOf(payload);
  if (response) {
    if (response.answer) await answerFromButton(response.question, response.answer);
    return true;
  }
  const question = parseRideQuestion(dataOf(payload));
  if (!question) return false;
  await askRide(question);
  return true;
}

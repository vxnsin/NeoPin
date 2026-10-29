import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { answerRide } from "@/lib/api";
import { readCredentials } from "@/lib/credentials";
import { dataOf } from "@/lib/pushPayload";
import { firstAnswer, firstAsk, forgetAnswer, offerRide, showRide, wasAnswered } from "@/lib/rideInbox";
import {
  RIDE_CATEGORY,
  RIDE_NO,
  RIDE_YES,
  parseRideQuestion,
  rideQuestionDetail,
  rideResponseOf,
  rideQuestionText,
  type RideAnswer,
  type RideQuestion,
} from "@/lib/rides";

// The channel lib/push.ts sets up; Android keeps it once it exists, also for the background task.
const CHANNEL_ID = "default";

const notificationId = (rideId: string) => `ride.${rideId}`;

// Yes and No answer without opening the app: Android hands the button to the background task
// (expo-notifications runs registered tasks for action buttons while the app is not in front).
let category: Promise<unknown> | null = null;
function rideCategory(): Promise<unknown> {
  category ??= Notifications.setNotificationCategoryAsync(RIDE_CATEGORY, [
    { identifier: RIDE_YES, buttonTitle: "Yes", options: { opensAppToForeground: false } },
    { identifier: RIDE_NO, buttonTitle: "No", options: { opensAppToForeground: false } },
  ]).catch(() => {
    category = null;
  });
  return category;
}

// The question travels in the notification's data, so a tap or a button brings it back whole.
const rideData = (question: RideQuestion) => ({ type: "rideQuestion", rideId: question.rideId, transit: question.transit, at: question.at });

async function present(question: RideQuestion, failed = false) {
  if (!failed) await rideCategory();
  await Notifications.scheduleNotificationAsync({
    identifier: notificationId(question.rideId),
    content: failed
      ? { title: "Your answer did not get through", body: `${rideQuestionText(question)} Tap to answer in NeoPin.`, data: rideData(question) }
      : { title: rideQuestionText(question), body: rideQuestionDetail(question), data: rideData(question), categoryIdentifier: RIDE_CATEGORY },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
  });
}

// Sends the answer once and takes the notification away. Throws when the server could not be reached,
// the answer may then be given again.
export async function sendRideAnswer(question: RideQuestion, answer: RideAnswer): Promise<void> {
  if (!(await firstAnswer(question.rideId))) return;
  try {
    const creds = await readCredentials();
    if (!creds) throw new Error("Not signed in.");
    await answerRide(creds, question.rideId, answer);
  } catch (error) {
    await forgetAnswer(question.rideId);
    throw error;
  }
  await Notifications.dismissNotificationAsync(notificationId(question.rideId)).catch(() => {});
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
// answered where the user is ("answered"); a tap opens the question on the map ("shown").
export function openRideResponse(payload: unknown): "answered" | "shown" | null {
  const response = rideResponseOf(payload);
  if (!response) return null;
  const { question, answer } = response;
  if (answer) {
    answerFromButton(question, answer);
    return "answered";
  }
  wasAnswered(question.rideId).then((done) => {
    if (!done) showRide(question);
  });
  return "shown";
}

// Asks a ride once, whichever way it came (socket, push, push task): as the sheet with the app in front,
// as a notification with Yes and No on Android otherwise. iPhones keep it for the map until the app is back.
export async function askRide(question: RideQuestion): Promise<void> {
  if (AppState.currentState === "active" || Platform.OS !== "android") await offerRide(question);
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

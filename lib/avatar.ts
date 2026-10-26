import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { deviceHeaders, httpBase, type DeviceAuth } from "@/lib/api";
import type { CropRect } from "@/lib/crop";

export { deviceHeaders, httpBase };

export const AVATAR_SIZE = 128;
// The server takes no more than this. A 128 px JPEG is a few KiB.
export const AVATAR_MAX_BYTES = 16 * 1024;

type Credentials = DeviceAuth;

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, index);
}

function problemMessage(status: number): string {
  switch (status) {
    case 401:
      return "Your login is no longer valid. Log in again.";
    case 404:
      return "The server does not know this picture.";
    case 413:
      return "The picture is too large.";
    case 415:
    case 400:
      return "The server did not take this picture.";
    case 429:
      return "Too many attempts. Wait a minute.";
    default:
      return `The server answered with ${status}.`;
  }
}

export type Photo = { uri: string; width: number; height: number };

// Lets the user pick a photo from the library, uncut. Resolves with null when they backed out.
export async function pickPhoto(): Promise<Photo | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: false,
    quality: 1,
  });
  if (result.canceled || !result.assets?.length) return null;
  const { uri, width, height } = result.assets[0];
  return { uri, width, height };
}

// Cuts the chosen square out of the photo and shrinks it to 128 px. The quality steps
// down until the JPEG fits what the server takes.
export async function renderAvatar(photo: Photo, rect: CropRect): Promise<Uint8Array> {
  for (const compress of [0.8, 0.6, 0.4]) {
    const image = await ImageManipulator.manipulate(photo.uri)
      .crop(rect)
      .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE })
      .renderAsync();
    const saved = await image.saveAsync({ compress, format: SaveFormat.JPEG, base64: true });
    const bytes = base64ToBytes(saved.base64 ?? "");
    if (bytes.length > 0 && bytes.length <= AVATAR_MAX_BYTES) return bytes;
  }
  throw new Error("The picture stays too large even at low quality.");
}

export async function uploadAvatar(creds: Credentials, jpeg: Uint8Array): Promise<string> {
  const response = await fetch(`${httpBase(creds.serverIp)}/api/avatar`, {
    method: "PUT",
    headers: { ...deviceHeaders(creds), "Content-Type": "image/jpeg" },
    body: jpeg as unknown as BodyInit,
  });
  if (!response.ok) throw new Error(problemMessage(response.status));
  const { avatarUrl } = await response.json();
  return avatarUrl;
}

export async function removeAvatar(creds: Credentials): Promise<void> {
  const response = await fetch(`${httpBase(creds.serverIp)}/api/avatar`, {
    method: "DELETE",
    headers: deviceHeaders(creds),
  });
  if (!response.ok) throw new Error(problemMessage(response.status));
}

// Loads a picture as a data URI, so the WebView map can show it without the headers.
export async function fetchAvatar(creds: Credentials, avatarUrl: string): Promise<string> {
  const response = await fetch(`${httpBase(creds.serverIp)}${avatarUrl}`, { headers: deviceHeaders(creds) });
  if (!response.ok) throw new Error(problemMessage(response.status));
  const type = response.headers.get("content-type") || "image/jpeg";
  const blob = await response.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the picture"));
    reader.readAsDataURL(blob);
  });
  // React Native's FileReader does not always know the type, the header does.
  return dataUrl.replace(/^data:[^;,]*/, `data:${type}`);
}

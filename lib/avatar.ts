import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { StoredCredentials } from "@/lib/socket";

export const AVATAR_SIZE = 128;
// The server takes no more than this. A 128 px JPEG is a few KiB.
export const AVATAR_MAX_BYTES = 16 * 1024;

type Credentials = Pick<StoredCredentials, "serverIp" | "deviceId" | "password">;

// The login stores the socket address. The HTTP routes live on the same host and path.
export function httpBase(socketUrl: string): string {
  return socketUrl
    .trim()
    .replace(/^ws(s?):\/\//i, (_, secure) => (secure ? "https://" : "http://"))
    .replace(/\/+$/, "");
}

// Header values have to stay ASCII, device names like "Luis’ iPhone" do not.
// The server decodes both.
export function deviceHeaders(creds: Credentials): Record<string, string> {
  return {
    "X-Device-Id": encodeURIComponent(creds.deviceId),
    Authorization: `Bearer ${encodeURIComponent(creds.password)}`,
  };
}

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
      return "The server did not accept the password.";
    case 404:
      return "The server does not know this device yet. Connect first.";
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

// Lets the user pick a photo, cuts a centred square and shrinks it to 128 px.
// Resolves with JPEG bytes, or null when the user backed out.
export async function pickAvatar(): Promise<Uint8Array | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  if (result.canceled || !result.assets?.length) return null;

  const { uri, width, height } = result.assets[0];
  const side = Math.min(width, height);
  for (const compress of [0.8, 0.6, 0.4]) {
    let context = ImageManipulator.manipulate(uri);
    if (side > 0) {
      context = context.crop({ originX: Math.floor((width - side) / 2), originY: Math.floor((height - side) / 2), width: side, height: side });
    }
    const image = await context.resize({ width: AVATAR_SIZE, height: AVATAR_SIZE }).renderAsync();
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
    body: jpeg,
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

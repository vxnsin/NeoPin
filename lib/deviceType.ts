import * as ExpoDevice from "expo-device";
import { Dimensions, Platform } from "react-native";
import type { DeviceType } from "@/lib/devices";

// expo-device reports 1 phone, 2 tablet, 3 desktop, 0 unknown.
export function deviceTypeFrom(value: number | null | undefined): DeviceType {
  if (value === ExpoDevice.DeviceType.TABLET) return "tablet";
  if (value === ExpoDevice.DeviceType.DESKTOP) return "desktop";
  return "phone";
}

// Expo Go and some builds report an iPad as a phone, so the platform's own checks and the
// model name back the answer up.
export function resolveDeviceType(info: {
  reported: number | null | undefined;
  isPad?: boolean;
  modelName?: string | null;
  shortestSide?: number;
}): DeviceType {
  const reported = deviceTypeFrom(info.reported);
  if (reported !== "phone") return reported;
  if (info.isPad || /ipad|tablet|\btab\b/i.test(info.modelName ?? "")) return "tablet";
  if (Platform.OS === "android" && (info.shortestSide ?? 0) >= 600) return "tablet";
  return "phone";
}

export function currentDeviceType(): DeviceType {
  try {
    const { width, height } = Dimensions.get("window");
    return resolveDeviceType({
      reported: ExpoDevice.deviceType,
      isPad: Platform.OS === "ios" && Platform.isPad,
      modelName: ExpoDevice.modelName,
      shortestSide: Math.min(width, height),
    });
  } catch {
    return "phone";
  }
}

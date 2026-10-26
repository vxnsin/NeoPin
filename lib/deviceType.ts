import * as ExpoDevice from "expo-device";
import type { DeviceType } from "@/lib/devices";

// expo-device reports 1 phone, 2 tablet, 3 desktop, 0 unknown.
export function deviceTypeFrom(value: number | null | undefined): DeviceType {
  if (value === ExpoDevice.DeviceType.TABLET) return "tablet";
  if (value === ExpoDevice.DeviceType.DESKTOP) return "desktop";
  return "phone";
}

export function currentDeviceType(): DeviceType {
  try {
    return deviceTypeFrom(ExpoDevice.deviceType);
  } catch {
    return "phone";
  }
}

import { requireOptionalNativeModule } from "expo";

// What the lock screen shows while a find runs.
export type LiveContent = {
  title: string;
  text: string;
  // The few characters that fit next to the icon in the status bar, "120 m".
  short: string;
  // Where to point, degrees clockwise from straight up. Null shows no arrow.
  arrowDeg: number | null;
};

export type LiveResult = "shown" | "denied" | "failed";

// What LiveModule.kt and LiveModule.swift offer. Spelled out here rather than through
// expo-modules-core's NativeModule type, which names the class, not an instance of it.
export type LiveNativeModule = {
  addListener(event: "onAction", listener: (event: { action: "stop" }) => void): { remove(): void };
  // Shows the notification (Android) or the Live Activity (iOS), or updates the one that is up.
  show(content: LiveContent): Promise<LiveResult>;
  hide(): Promise<void>;
};

// Null in builds from before the module existed, on iOS also in those without the Live Activity:
// they get this JavaScript through EAS Update too.
export const LiveNative: LiveNativeModule | null = requireOptionalNativeModule<LiveNativeModule>("NeoPinLive");

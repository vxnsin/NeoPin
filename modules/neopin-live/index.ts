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

// What LiveModule.kt offers. Spelled out here rather than through expo-modules-core's
// NativeModule type, which names the class, not an instance of it.
export type LiveNativeModule = {
  addListener(event: "onAction", listener: (event: { action: "stop" }) => void): { remove(): void };
  // Shows the notification, or updates the one that is up.
  show(content: LiveContent): Promise<LiveResult>;
  hide(): Promise<void>;
};

// Null on iOS, where the Live Activity takes this part, and in builds from before the module
// existed: those get this JavaScript through EAS Update too.
export const LiveNative: LiveNativeModule | null = requireOptionalNativeModule<LiveNativeModule>("NeoPinLive");

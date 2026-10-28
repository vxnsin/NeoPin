import { requireOptionalNativeModule } from "expo";

// What WidgetsModule.kt and WidgetsModule.swift offer: the app hands over one JSON snapshot,
// the native side stores it where the widgets can read it and redraws them. An empty string
// clears it.
export type WidgetsNativeModule = {
  update(json: string): Promise<void>;
};

// Null in builds from before the widgets existed: those get this JavaScript through EAS
// Update too, and simply have no widgets.
export const WidgetsNative: WidgetsNativeModule | null = requireOptionalNativeModule<WidgetsNativeModule>("NeoPinWidgets");

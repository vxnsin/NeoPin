import { requireOptionalNativeModule } from "expo";

export type NearbyRadioState = "ready" | "off" | "unsupported" | "unauthorized" | "failed";
export type NearbySighting = { rssi: number; at: number };

type NearbyEvents = {
  onSighting: (sighting: NearbySighting) => void;
  onState: (event: { state: NearbyRadioState; code?: number }) => void;
};

// What NearbyModule.kt and NearbyModule.swift offer. Spelled out here rather than through
// expo-modules-core's NativeModule type, which names the class, not an instance of it.
export type NearbyNativeModule = {
  addListener<E extends keyof NearbyEvents>(event: E, listener: NearbyEvents[E]): { remove(): void };
  // Sends out the UUID and listens for it until stop(). Resolves with the radio's state.
  start(uuid: string): Promise<NearbyRadioState>;
  stop(): Promise<void>;
};

// Null in builds from before the module existed: those get this JavaScript through EAS Update
// too, and simply do without Bluetooth.
export const NearbyNative: NearbyNativeModule | null = requireOptionalNativeModule<NearbyNativeModule>("NeoPinNearby");

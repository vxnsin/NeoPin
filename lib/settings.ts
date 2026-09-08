import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";

export type ReportingPreset = "battery" | "balanced" | "precise";

export const REPORTING_PRESETS: Record<
  ReportingPreset,
  { label: string; description: string; timeInterval: number; distanceInterval: number; accuracy: Location.Accuracy }
> = {
  battery: {
    label: "Battery saver",
    description: "Every 2 minutes or 100 m",
    timeInterval: 120_000,
    distanceInterval: 100,
    accuracy: Location.Accuracy.Balanced,
  },
  balanced: {
    label: "Balanced",
    description: "Every 15 seconds or 10 m",
    timeInterval: 15_000,
    distanceInterval: 10,
    accuracy: Location.Accuracy.High,
  },
  precise: {
    label: "Precise",
    description: "Every 5 seconds or 3 m",
    timeInterval: 5_000,
    distanceInterval: 3,
    accuracy: Location.Accuracy.BestForNavigation,
  },
};

const SETTINGS_KEY = "settings";

type Settings = { reporting: ReportingPreset };

let settings: Settings = { reporting: "balanced" };
let loaded = false;
let listeners: ((s: Settings) => void)[] = [];

export async function loadSettings(): Promise<Settings> {
  if (loaded) return settings;
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.reporting in REPORTING_PRESETS) settings = { ...settings, reporting: parsed.reporting };
    }
  } catch {
    // keep defaults
  }
  loaded = true;
  return settings;
}

export function getReportingPreset(): ReportingPreset {
  return settings.reporting;
}

export async function setReportingPreset(preset: ReportingPreset) {
  settings = { ...settings, reporting: preset };
  listeners.forEach((fn) => fn(settings));
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // best effort
  }
}

export function onSettingsChange(listener: (s: Settings) => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

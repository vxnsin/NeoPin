import { requireOptionalNativeModule } from "expo";

export type BatteryReport = { level: number; charging: boolean };

// expo-battery needs its native module. Builds from before it was added get this
// JavaScript through EAS Update too, so it is only loaded where the module exists.
const Battery: typeof import("expo-battery") | null = requireOptionalNativeModule("ExpoBattery")
  ? require("expo-battery")
  : null;

// BatteryState.CHARGING and BatteryState.FULL: plugged in, whether it still charges or not.
const PLUGGED_IN = [2, 3];

// The charge in whole percent and whether it is plugged in. Simulators and devices
// without a battery report -1, those get no battery at all.
export function toReport(level: number, state: number): BatteryReport | null {
  if (!(level >= 0)) return null;
  return { level: Math.round(Math.min(1, level) * 100), charging: PLUGGED_IN.includes(state) };
}

export async function readBattery(): Promise<BatteryReport | null> {
  if (!Battery) return null;
  try {
    const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
    return toReport(level, state);
  } catch {
    return null;
  }
}

// Servers that know about batteries list a battery (or null) with every device. Older
// ones would close the socket on an updateBattery, so that message waits until the
// server has shown it knows. The battery inside updatePosition is safe either way,
// unknown fields are dropped there. Every device list decides anew, so after a switch
// to another server only that server's answer counts.
let serverKnowsBattery = false;

export function noteServerDevices(devices: unknown) {
  if (!Array.isArray(devices) || devices.length === 0) return;
  serverKnowsBattery = devices.some((d) => d && typeof d === "object" && "battery" in d);
}

export function serverTakesBattery(): boolean {
  return serverKnowsBattery;
}

// On logout, so the next server starts unknown.
export function resetServerBattery() {
  serverKnowsBattery = false;
}

// Android only reports the level at thresholds like "battery low", not every percent,
// so the charge is also looked at every two minutes while reporting runs.
const POLL_MS = 2 * 60 * 1000;

// Calls back when the charge moves by a whole percent or the phone is plugged in or
// out, so a phone lying on the charger still shows how full it is.
export function watchBattery(onChange: (report: BatteryReport) => void): () => void {
  if (!Battery) return () => {};
  let last: BatteryReport | null = null;
  const check = async () => {
    const report = await readBattery();
    if (!report || (last && last.level === report.level && last.charging === report.charging)) return;
    last = report;
    onChange(report);
  };
  const subscriptions = [Battery.addBatteryLevelListener(check), Battery.addBatteryStateListener(check)];
  const poll = setInterval(check, POLL_MS);
  return () => {
    clearInterval(poll);
    subscriptions.forEach((subscription) => subscription.remove());
  };
}

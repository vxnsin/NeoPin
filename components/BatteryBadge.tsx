import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import { STATE_COLORS, type DeviceBattery } from "@/lib/devices";
import { clockTime } from "@/lib/time";

const LOW = 20;

// What a screen reader says for the badge; the rows that hold a badge append it to their label.
export function batteryLabel(battery: DeviceBattery, stale: boolean): string {
  const level = Math.max(0, Math.min(100, Math.round(battery.level)));
  if (stale) {
    const when = clockTime(battery.updatedAt);
    return `battery ${level} percent when last heard from${when ? `, ${when}` : ""}`;
  }
  return `battery ${level} percent${battery.charging ? ", charging" : ""}`;
}

// A small battery filled to its charge, then the percent: red when it runs low,
// green with a bolt while it charges. Same look as on the dashboard.
// Stale is the last reading of a device that is offline: faded, with the time it was
// taken, and without the colours, since nobody knows what the phone does now.
export default function BatteryBadge({ battery, stale = false }: { battery: DeviceBattery; stale?: boolean }) {
  const { colors } = useThemeManager();
  const level = Math.max(0, Math.min(100, Math.round(battery.level)));
  const charging = battery.charging && !stale;
  const color = charging ? STATE_COLORS.online : level <= LOW && !stale ? colors.secondary : colors.muted;
  const when = stale ? clockTime(battery.updatedAt) : "";

  return (
    <View
      style={[styles.badge, stale && styles.stale]}
      accessible
      accessibilityLabel={batteryLabel(battery, stale)}
    >
      <View style={[styles.cell, { borderColor: color }]}>
        <View style={[styles.fill, { width: `${level}%`, backgroundColor: color }]} />
      </View>
      <View style={[styles.nub, { backgroundColor: color }]} />
      <Text style={[styles.text, { color }]}>{level} %</Text>
      {charging ? <MaterialIcons name="bolt" size={13} color={color} style={styles.bolt} /> : null}
      {when ? <Text style={[styles.when, { color }]}>{when}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: "row", alignItems: "center", marginLeft: 6, flexShrink: 0 },
  cell: { width: 18, height: 9, padding: 1, borderWidth: 1.5, borderRadius: 3 },
  fill: { height: "100%", minWidth: 1, borderRadius: 1 },
  nub: { width: 2, height: 4, marginLeft: 1, borderTopRightRadius: 1, borderBottomRightRadius: 1 },
  text: { marginLeft: 5, fontSize: 12, fontVariant: ["tabular-nums"] },
  bolt: { marginLeft: 1 },
  stale: { opacity: 0.6 },
  when: { marginLeft: 4, fontSize: 11, fontVariant: ["tabular-nums"] },
});

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import { STATE_COLORS, type DeviceBattery } from "@/lib/devices";

const LOW = 20;

// A small battery filled to its charge, then the percent: red when it runs low,
// green with a bolt while it charges. Same look as on the dashboard.
export default function BatteryBadge({ battery }: { battery: DeviceBattery }) {
  const { colors } = useThemeManager();
  const level = Math.max(0, Math.min(100, Math.round(battery.level)));
  const color = battery.charging ? STATE_COLORS.online : level <= LOW ? colors.secondary : colors.muted;

  return (
    <View
      style={styles.badge}
      accessible
      accessibilityLabel={`Battery ${level} percent${battery.charging ? ", charging" : ""}`}
    >
      <View style={[styles.cell, { borderColor: color }]}>
        <View style={[styles.fill, { width: `${level}%`, backgroundColor: color }]} />
      </View>
      <View style={[styles.nub, { backgroundColor: color }]} />
      <Text style={[styles.text, { color }]}>{level} %</Text>
      {battery.charging ? <MaterialIcons name="bolt" size={13} color={color} style={styles.bolt} /> : null}
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
});

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import useThemeManager from "@/hooks/useThemeManager";
import { formatAltitude, profileBars, readProfile } from "@/lib/altitude";

type Props = {
  // The trip's elevation as the server sent it, [[distanceM, altitudeM], …].
  elevation: unknown;
  // The trip's colour; the fill is a lighter shade of it.
  color: string;
  height?: number;
};

// Enough columns to read as a line on a phone, few enough to stay cheap in a long day.
const COLUMNS = 48;

const HEX = /^#[0-9a-f]{6}$/i;

// The small height profile under a trip: thin columns, a light fill with a line on top.
// Nothing when the trip has no profile (older servers, a stretch without fixes).
export default function ElevationProfile({ elevation, color, height = 22 }: Props) {
  const { colors: c, isDark } = useThemeManager();
  const bars = useMemo(() => profileBars(readProfile(elevation), COLUMNS), [elevation]);
  if (!bars) return null;
  const line = HEX.test(color) ? color : c.muted;
  const fill = `${line}${isDark ? "59" : "38"}`;
  return (
    <View
      style={[styles.profile, { height }]}
      accessible
      accessibilityLabel={`Height profile, ${formatAltitude(bars.lowM)} to ${formatAltitude(bars.highM)}`}
    >
      {bars.ratios.map((ratio, i) => (
        <View key={i} style={[styles.column, { height: `${ratio * 100}%`, backgroundColor: fill, borderTopColor: line }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: "row", alignItems: "flex-end", marginTop: 6, borderRadius: 4, overflow: "hidden" },
  column: { flex: 1, borderTopWidth: 1.5 },
});

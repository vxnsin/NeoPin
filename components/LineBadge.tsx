import React from "react";
import { StyleSheet, Text, View } from "react-native";
import useThemeManager from "@/hooks/useThemeManager";

type Props = {
  line: string;
  // The line's own colours; without them the badge is quiet on the surface it sits on.
  color: string | null;
  textColor: string | null;
  large?: boolean;
};

// "10" or "RB 53" in the line's colours, as in the timeline and the ride question.
export default function LineBadge({ line, color, textColor, large }: Props) {
  const { colors: c } = useThemeManager();
  return (
    <View style={[styles.badge, large && styles.large, { backgroundColor: color ?? c.raised, borderColor: color ?? c.subtle }]}>
      <Text style={[styles.text, large && styles.largeText, { color: textColor ?? c.primary }]} numberOfLines={1}>
        {line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { minWidth: 30, height: 22, paddingHorizontal: 7, borderRadius: 7, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  text: { fontSize: 12.5, fontWeight: "800" },
  large: { minWidth: 44, height: 32, paddingHorizontal: 10, borderRadius: 9 },
  largeText: { fontSize: 16 },
});

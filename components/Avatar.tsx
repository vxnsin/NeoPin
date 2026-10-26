import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { STATE_COLORS, avatarColor, initials, type Freshness } from "@/lib/devices";

type Props = {
  name: string;
  uri?: string | null;
  state: Freshness;
  size?: number;
  // The gap between picture and ring, usually the background it sits on.
  gapColor: string;
};

// A round profile picture, or the device's initials, inside its status ring.
export default function Avatar({ name, uri, state, size = 40, gapColor }: Props) {
  const ring = 2.5;
  const gap = 2;
  const outer = size + 2 * (ring + gap);
  const offline = state === "offline";

  return (
    <View
      style={[
        styles.ring,
        { width: outer, height: outer, borderRadius: outer / 2, borderWidth: ring, borderColor: STATE_COLORS[state], padding: gap, backgroundColor: gapColor },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {uri ? (
        <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, opacity: offline ? 0.55 : 1 }} />
      ) : (
        <View
          style={[
            styles.initials,
            { width: size, height: size, borderRadius: size / 2, backgroundColor: offline ? STATE_COLORS.offline : avatarColor(name) },
          ]}
        >
          <Text style={[styles.initialsText, { fontSize: size * 0.38 }]}>{initials(name)}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { alignItems: "center", justifyContent: "center" },
  initials: { alignItems: "center", justifyContent: "center" },
  initialsText: { color: "#ffffff", fontWeight: "700", letterSpacing: 0.3 },
});

import React, { useEffect, useRef } from "react";
import { Alert, Animated, Easing, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";

type Props = { top: number; dashboard: string; onDismiss: () => void };

// For an admin whose server still waits for its setup: the first group and people are made in the
// dashboard, the app only points there. Gone for the session once closed.
export default function SetupBanner({ top, dashboard, onDismiss }: Props) {
  const { colors: c } = useThemeManager();
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);

  const open = () =>
    Linking.openURL(dashboard).catch(() => Alert.alert("Dashboard", `Open ${dashboard} in your browser to finish the setup.`));

  const dismiss = () => Animated.timing(enter, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => onDismiss());

  return (
    <Animated.View
      style={[
        styles.banner,
        {
          top,
          backgroundColor: c.raised,
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
        },
      ]}
    >
      <Pressable
        style={({ pressed }) => [styles.press, { opacity: pressed ? 0.7 : 1 }]}
        onPress={open}
        accessibilityRole="link"
        accessibilityLabel="Finish setting up your server in the dashboard"
      >
        <View style={[styles.icon, { backgroundColor: c.subtle }]}>
          <MaterialIcons name="dashboard" size={18} color={c.secondary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: c.primary }]}>Finish setting up your server in the dashboard</Text>
          <Text style={[styles.meta, { color: c.muted }]} numberOfLines={1}>
            {dashboard.replace(/^https?:\/\//i, "")}
          </Text>
        </View>
        <MaterialIcons name="open-in-new" size={18} color={c.muted} />
      </Pressable>
      <Pressable onPress={dismiss} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="Hide the setup hint">
        <MaterialIcons name="close" size={18} color={c.muted} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 10,
    borderRadius: 18,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  press: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 14, fontWeight: "700" },
  meta: { fontSize: 12, marginTop: 2 },
  close: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
});

import React from "react";
import { TouchableOpacity, Text, StyleSheet, Linking } from "react-native";
import { FontAwesome } from "@expo/vector-icons";
import pkg from "@/package.json";
import useThemeManager from "@/hooks/useThemeManager";

export default function Footer() {
  const colors = useThemeManager();

  return (
    <TouchableOpacity
      style={styles.footer}
      onPress={() => Linking.openURL("https://github.com/vxnsin/NeoPin")}
    >
      <FontAwesome name="github" size={24} color={colors.colors.primary} />
      <Text style={[styles.footerText, { color: colors.colors.primary }]}>
        {`v${pkg.version}`}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  footer: {
    position: "absolute",
    flexDirection: "row",
    bottom: 50,
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    zIndex: 999,
  },
  footerText: {
    marginLeft: 8,
    fontSize: 16,
  },
});

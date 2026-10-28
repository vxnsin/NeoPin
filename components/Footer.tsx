import React from "react";
import { TouchableOpacity, Text, StyleSheet, Linking } from "react-native";
import { FontAwesome } from "@expo/vector-icons";
import Constants from "expo-constants";
import useThemeManager from "@/hooks/useThemeManager";

export default function Footer() {
  const colors = useThemeManager();
  // The app version lives in app.config.js, package.json is never bumped. With an over-the-air
  // update this is the version of the running update, like the label in the settings.
  const version = Constants.expoConfig?.version;

  return (
    <TouchableOpacity
      style={styles.footer}
      onPress={() => Linking.openURL("https://github.com/vxnsin/NeoPin")}
    >
      <FontAwesome name="github" size={24} color={colors.colors.primary} />
      {version && (
        <Text style={[styles.footerText, { color: colors.colors.primary }]}>
          {`v${version}`}
        </Text>
      )}
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

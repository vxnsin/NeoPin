import React from "react";
import { TouchableOpacity, Text, StyleSheet, Linking } from "react-native";
import { FontAwesome } from "@expo/vector-icons";
import Constants from "expo-constants";
import useThemeManager from "@/hooks/useThemeManager";

type Props = {
  // At the end of a scrolling screen instead of pinned to the bottom, so it never sits on a
  // form field (the sign-up is longer than a phone screen).
  inline?: boolean;
};

export default function Footer({ inline }: Props) {
  const colors = useThemeManager();
  // The app version lives in app.config.js, package.json is never bumped. With an over-the-air
  // update this is the version of the running update, like the label in the settings.
  const version = Constants.expoConfig?.version;

  return (
    <TouchableOpacity
      style={inline ? styles.inline : styles.footer}
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
  inline: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginTop: 36,
    paddingVertical: 8,
  },
  footerText: {
    marginLeft: 8,
    fontSize: 16,
  },
});

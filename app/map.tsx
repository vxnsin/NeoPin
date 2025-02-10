import React from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import useThemeManager from "@/hooks/useThemeManager";

export default function MapPlaceholder() {
  const colors = useThemeManager();

  return (
    <View style={[styles.container, { backgroundColor: colors.colors.surface }]}>
      <ActivityIndicator size="large" color={colors.colors.primary} />
      <Text style={[styles.text, { color: colors.colors.primary }]}>Loading Map...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  text: {
    marginTop: 10,
    fontSize: 18,
    fontWeight: "bold",
  },
});

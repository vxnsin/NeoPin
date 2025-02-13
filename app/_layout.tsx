import React, { useEffect } from "react";
import { View, Dimensions, StyleSheet } from "react-native";
import { Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import useThemeManager from "@/hooks/useThemeManager";
import { WebSocketProvider } from "@/context/WebSocket";
import Footer from "@/components/Footer";

export default function RootLayout() {
  const theme = useThemeManager();
  const pathname = usePathname();

  useEffect(() => {
    async function prepare() {
      await SplashScreen.preventAutoHideAsync();
      setTimeout(() => {
        SplashScreen.hideAsync();
      }, 2000);
    }
    prepare();
  }, []);

  return (
    <WebSocketProvider>
      <View
        style={[styles.container, { backgroundColor: theme.colors.surface }]}
      >
        <Stack
          screenOptions={{
            headerShown: false,
            animation: "fade",
          }}
        />
        {pathname !== "/map" && <Footer />}
      </View>
    </WebSocketProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: Dimensions.get("window").height,
    position: "relative",
  },
});

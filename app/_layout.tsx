import React, { useEffect } from "react";
import { View, Dimensions, StyleSheet, AppState, Platform } from "react-native";
import { Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import useThemeManager from "@/hooks/useThemeManager";
import { WebSocketProvider, useWebSocketContext } from "@/context/WebSocket";
import Footer from "@/components/Footer";
import { startWebSocketService, stopWebSocketService } from "@/services/WebSocketService";
import { startPositionReporting } from "@/handlers/Location";
import { startBackgroundLocation } from "@/tasks/LocationTask";

function ConnectionLifecycle() {
  const { emit, isConnected } = useWebSocketContext();

  useEffect(() => {
    if (!isConnected) return;
    const stop = startPositionReporting({ emit });
    if (Platform.OS === "ios") {
      startBackgroundLocation().catch((error) =>
        console.warn("Background location unavailable:", error?.message)
      );
    }
    return stop;
  }, [isConnected, emit]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        startWebSocketService();
      } else if (state === "active") {
        stopWebSocketService();
      }
    });
    return () => subscription.remove();
  }, []);

  return null;
}

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
      <ConnectionLifecycle />
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

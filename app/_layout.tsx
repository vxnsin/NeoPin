import React, { useEffect, useState } from "react";
import { AppState, View, Dimensions, StyleSheet } from "react-native";
import { Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import useThemeManager from "@/hooks/useThemeManager";
import { WebSocketProvider, useWebSocketContext } from "@/context/WebSocket";
import Footer from "@/components/Footer";
import { socket } from "@/lib/socket";
import { checkAndPrompt } from "@/lib/updates";
import { logout } from "@/lib/logout";
import { startPositionReporting } from "@/handlers/Location";
import { startBackgroundLocation } from "@/tasks/LocationTask";
import {
  REPORTING_PRESETS,
  getReportingPreset,
  loadSettings,
  onSettingsChange,
  type ReportingPreset,
} from "@/lib/settings";

function ConnectionLifecycle() {
  const { emit, isConnected } = useWebSocketContext();
  const router = useRouter();
  const [preset, setPreset] = useState<ReportingPreset>(getReportingPreset());

  // The server no longer accepts the token (logged out elsewhere, kicked, expired).
  useEffect(
    () =>
      socket.onRejected(() => {
        logout({ remote: false })
          .catch(() => {})
          .finally(() => router.replace("/login"));
      }),
    [router]
  );

  // A new version is downloaded as soon as the app is open, and the user is asked to restart.
  useEffect(() => {
    checkAndPrompt();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") checkAndPrompt();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    loadSettings().then((s) => setPreset(s.reporting));
    return onSettingsChange((s) => setPreset(s.reporting));
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    const stop = startPositionReporting({ emit }, REPORTING_PRESETS[preset]);
    const startBackground = () =>
      startBackgroundLocation(REPORTING_PRESETS[preset]).catch((error) =>
        console.warn("Background location unavailable:", error?.message)
      );
    startBackground();
    // The permission dialogs send the app to the background and back. Once it is in front again
    // (and the permissions are granted) the background service can start.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") startBackground();
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, [isConnected, emit, preset]);

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
      <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
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

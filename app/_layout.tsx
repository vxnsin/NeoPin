import React, { useEffect, useRef, useState } from "react";
import { AppState, View, Dimensions, StyleSheet } from "react-native";
import { Stack, usePathname, useRouter } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import useThemeManager from "@/hooks/useThemeManager";
import { WebSocketProvider, useWebSocketContext } from "@/context/WebSocket";
import Footer from "@/components/Footer";
import { socket, readCredentials } from "@/lib/socket";
import { openFromNotification, startPush } from "@/lib/push";
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

  // The device token for push goes to the server once the app is connected, and stays up to date.
  useEffect(() => {
    if (!isConnected) return;
    let stop = () => {};
    let cancelled = false;
    readCredentials().then((creds) => {
      if (creds && !cancelled) stop = startPush(creds);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [isConnected]);

  // Tapping a notification, also the one that started the app, opens what it is about.
  const lastResponse = Notifications.useLastNotificationResponse();
  const handledResponse = useRef<string | null>(null);
  useEffect(() => {
    if (!lastResponse) return;
    const key = `${lastResponse.notification.request.identifier}:${lastResponse.notification.date}`;
    if (handledResponse.current === key) return;
    handledResponse.current = key;
    if (openFromNotification(lastResponse)) router.navigate("/map");
  }, [lastResponse, router]);

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

  // The start screen hides the splash the moment it is drawn, with the logo in the same place.
  // The timer is only a safety net for a screen that never gets there.
  useEffect(() => {
    SplashScreen.preventAutoHideAsync().catch(() => {});
    const timer = setTimeout(() => SplashScreen.hideAsync().catch(() => {}), 5000);
    return () => clearTimeout(timer);
  }, []);

  return (
    // The gestures of the sheets run natively and need this root above them.
    <GestureHandlerRootView style={styles.root}>
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
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: {
    flex: 1,
    minHeight: Dimensions.get("window").height,
    position: "relative",
  },
});

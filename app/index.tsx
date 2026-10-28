import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import useThemeManager from "@/hooks/useThemeManager";
import { useWebSocketContext } from "@/context/WebSocket";
import StartScreen from "@/components/StartScreen";
import usePermissions from "@/hooks/usePermission";
import { readCredentials, socket } from "@/lib/socket";

const INTRO_KEY = "introSeen";
// The first start lingers on the name and the tagline before it goes on.
const INTRO_MS = 2200;

export default function Index() {
  const theme = useThemeManager();
  const router = useRouter();
  const { connect } = useWebSocketContext();
  // null while we look up whether this is the first start.
  const [showIntro, setShowIntro] = useState<boolean | null>(null);
  const [introDone, setIntroDone] = useState(false);

  usePermissions();

  useEffect(() => {
    AsyncStorage.getItem(INTRO_KEY)
      .then((seen) => setShowIntro(!seen))
      .catch(() => setShowIntro(false));
  }, []);

  useEffect(() => {
    if (!showIntro) return;
    const timer = setTimeout(() => setIntroDone(true), INTRO_MS);
    return () => clearTimeout(timer);
  }, [showIntro]);

  const finishIntro = useCallback(() => {
    AsyncStorage.setItem(INTRO_KEY, "1").catch(() => {});
    setShowIntro(false);
  }, []);

  useEffect(() => {
    if (showIntro !== false) return;
    let active = true;

    (async () => {
      const creds = await readCredentials();
      if (!creds) {
        if (active) router.replace("/login");
        return;
      }
      try {
        if (!socket.connected) await connect(creds.serverIp, creds.deviceId, creds.token);
        if (active) router.replace("/map");
      } catch (error: any) {
        // A refused token already sent the user back to the login.
        if (!active || socket.rejected) return;
        router.replace({
          pathname: "/error",
          params: {
            error: "Connection failed",
            description: error?.message || "Unable to reach the server.",
            icon: "wifi-off",
          },
        });
      }
    })();

    return () => {
      active = false;
    };
  }, [showIntro, connect, router]);

  // The same start screen in every case: the splash hands over to it without a jump. On the
  // first start it carries the tagline and fades out towards the login; otherwise it stays
  // until the map screen takes over with the logo at rest.
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
      {showIntro ? (
        <StartScreen ready={introDone} leave="fade" tagline="Your devices. Your server." onHidden={finishIntro} />
      ) : (
        <StartScreen ready={false} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});

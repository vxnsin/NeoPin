import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import useThemeManager from "@/hooks/useThemeManager";
import { useWebSocketContext } from "@/context/WebSocket";
import Intro from "@/components/Intro";
import PulseLogo from "@/components/PulseLogo";
import usePermissions from "@/hooks/usePermission";
import { readCredentials, socket } from "@/lib/socket";

const INTRO_KEY = "introSeen";

export default function Index() {
  const theme = useThemeManager();
  const router = useRouter();
  const { connect } = useWebSocketContext();
  // null while we look up whether this is the first start.
  const [showIntro, setShowIntro] = useState<boolean | null>(null);

  usePermissions();

  useEffect(() => {
    AsyncStorage.getItem(INTRO_KEY)
      .then((seen) => setShowIntro(!seen))
      .catch(() => setShowIntro(false));
  }, []);

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

  if (showIntro) return <Intro onDone={finishIntro} />;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
      <PulseLogo size={84} />
      <Text style={[styles.text, { color: theme.colors.muted }]}>Connecting to your server…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  text: { marginTop: -24, fontSize: 15, fontWeight: "500" },
});

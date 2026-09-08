import React, { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import useThemeManager from "@/hooks/useThemeManager";
import { useWebSocketContext } from "@/context/WebSocket";
import Loader from "@/components/Loader";
import usePermissions from "@/hooks/usePermission";
import { readCredentials, socket } from "@/lib/socket";

export default function Index() {
  const theme = useThemeManager();
  const router = useRouter();
  const { connect } = useWebSocketContext();
  const [loaded, setLoaded] = useState(false);

  usePermissions();

  useEffect(() => {
    let active = true;

    (async () => {
      const creds = await readCredentials();
      if (!creds) {
        if (active) router.replace("/login");
        return;
      }
      if (socket.connected) {
        if (active) setLoaded(true);
        return;
      }
      try {
        await connect(creds.serverIp, creds.deviceId, creds.password);
        if (active) setLoaded(true);
      } catch (error: any) {
        if (!active) return;
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
  }, [connect, router]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
      <Loader
        text="Connecting"
        loop={true}
        duration={14050}
        instant={loaded}
        onComplete={() => router.replace("/map")}
      />
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
});

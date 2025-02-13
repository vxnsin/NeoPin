import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Linking,
} from "react-native";
import useThemeManager from "@/hooks/useThemeManager";
import { useAsyncStorage } from "@/hooks/useAsyncStorage";
import { useRouter } from "expo-router";
import { useWebSocketContext } from "@/context/WebSocket";
import Loader from "@/components/Loader";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
import useNotify from "@/hooks/useNotify";
import usePermissions from "@/hooks/usePermission";

export default function Index() {
  const colors = useThemeManager();
  const { getValue } = useAsyncStorage("userData");
  const router = useRouter();
  const { connect, close } = useWebSocketContext();

  const MAX_RETRIES = 3;
  const [loaded, setLoaded] = useState(false);
  const isMounted = useRef(true);
  const connectRef = useRef(connect);
  const disconnectRef = useRef(close);
  const attemptCount = useRef(0);
  const expoPushToken = useNotify();

  usePermissions();

  useEffect(() => {
    connectRef.current = connect;
    disconnectRef.current = close;
  }, [connect, close]);

  useEffect(() => {
    isMounted.current = true;
    let timeoutId: NodeJS.Timeout | null = null;

    const attemptConnection = async () => {
      const userData = await getValue();
      if (!userData) {
        if (isMounted.current) {
          router.replace("/login");
          console.log("Expo Push Token:", expoPushToken);


        }
        return;
      }

      const { serverIp, deviceId, password } = JSON.parse(userData);

      const connectWithRetry = async (isFirstAttempt = false) => {
        if (attemptCount.current >= MAX_RETRIES) {
          if (isMounted.current) {
            router.replace(
              "/error?error=Connection Failed&description=Unable to connect after multiple attempts.&icon=wifi-off"
            );
          }
          return;
        }

        try {
          if (!isFirstAttempt) {
            await delay(2500);
          }
          await connectRef.current(serverIp, deviceId, password, {
            reconnecting: false,
          });

          if (isMounted.current) {
            setLoaded(true);
          }
        } catch (error: any) {
          attemptCount.current++;
          console.error(
            `Connection error (Attempt ${attemptCount.current}/${MAX_RETRIES}):`,
            error
          );
          if (isMounted.current && attemptCount.current < MAX_RETRIES) {
            timeoutId = setTimeout(() => connectWithRetry(false), 3000);
          } else {
            router.replace(
              "/error?error=Connection Failed&description=Unable to connect after multiple attempts.&icon=wifi-off"
            );
          }
        }
      };

      connectWithRetry(true);
    };

    attemptConnection();

    return () => {
      isMounted.current = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [getValue, router]);

  return (
    <View
      style={[styles.container, { backgroundColor: colors.colors.surface }]}
    >
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
  text: {
    marginTop: 10,
    fontSize: 16,
    fontWeight: "bold",
  },
  errorText: {
    fontSize: 18,
    fontWeight: "bold",
  },
});

import React, { useState, useEffect, useRef } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import useThemeManager from "@/hooks/useThemeManager";
import { useAsyncStorage } from "@/hooks/useAsyncStorage";
import { useRouter } from "expo-router";
import { useWebSocket } from "@/hooks/useWebSocket";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export default function Index() {
  const colors = useThemeManager();
  const { getValue } = useAsyncStorage("userData");
  const router = useRouter();
  const { connect, close } = useWebSocket();

  const MAX_RETRIES = 3;
  const [status, setStatus] = useState<
    "connecting" | "authenticated" | "error" | `Retrying`
  >("connecting");

  const isMounted = useRef(true);
  const connectRef = useRef(connect);
  const disconnectRef = useRef(close);
  const attemptCount = useRef(0);

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
          setStatus("error");
          router.replace("/login");
        }
        return;
      }

      const { serverIp, deviceId, password } = JSON.parse(userData);

      const connectWithRetry = async () => {
        if (attemptCount.current >= MAX_RETRIES) {
          if (isMounted.current) {
            setStatus("error");
            router.replace("/error?error=Connection Failed&description=Unable to connect after multiple attempts.");
          }
          return;
        }

        if (isMounted.current) {
          setStatus(
            attemptCount.current === 0 
              ? "connecting" 
              : `Retrying`
          );
        }

        try {
          await delay(2500);
          await connectRef.current(serverIp, deviceId, password, { reconnecting: false });

          if (isMounted.current) {
            setStatus("authenticated");
            router.replace("/map");
          }
        } catch (error: any) {
          attemptCount.current++;
          console.error(`Connection error (Attempt ${attemptCount.current}/${MAX_RETRIES}):`, error);

          if (isMounted.current) {
            if (attemptCount.current < MAX_RETRIES) {
              timeoutId = setTimeout(connectWithRetry, 3000);
            } else {
              setStatus("error");
              router.replace("/error?error=Connection Failed&description=Unable to connect after multiple attempts.");
            }
          }
        }
      };

      connectWithRetry();
    };

    attemptConnection();

    return () => {
      isMounted.current = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [getValue, router]);

  if (status === "connecting" || status  === "Retrying") {
    return (
      <View style={[styles.container, { backgroundColor: colors.colors.surface }]}>
        <ActivityIndicator size="large" color={colors.colors.primary} />
        <Text style={[styles.text, { color: colors.colors.primary }]}>
          {status === "connecting" ? "Connecting..." : status}
        </Text>
      </View>
    );
  }

  if (status === "error") {
    return (
      <View style={[styles.container, { backgroundColor: colors.colors.surface }]}>
        <Text style={[styles.errorText, { color: colors.colors.primary }]}>
          ⚠️ Cannot connect to the server.
        </Text>
      </View>
    );
  }

  return null;
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
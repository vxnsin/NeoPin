import React, { useState, useEffect } from "react";
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
  const ws = useWebSocket();

  const MAX_RETRIES = 3;
  const [status, setStatus] = useState<
    "connecting" | "authenticated" | "error" | `Retrying (${number}/${number})`
  >("connecting");

  useEffect(() => {
    let isMounted = true;
    let attemptCount = 0;
  
    const attemptConnection = async () => {
      const userData = await getValue();
      if (!userData) {
        if (isMounted) {
          setStatus("error");
          router.replace("/login");
        }
        return;
      }
  
      const { serverIp, deviceId, password } = JSON.parse(userData);
  
      const connectWithRetry = async () => {
        if (attemptCount >= MAX_RETRIES) {
          if (isMounted) {
            setStatus("error");
            router.replace("/error?error=Connection Failed&description=Unable to connect after multiple attempts.");
          }
          return;
        }
  
        if (isMounted) {
          setStatus(attemptCount === 0 ? "connecting" : `Retrying (${attemptCount}/${MAX_RETRIES})`);
        }
  
        try {
          await delay(2500);
          await ws.connect(serverIp, deviceId, password, { reconnecting: false });
  
          if (isMounted) {
            setStatus("authenticated");
            router.replace("/");
          }
        } catch (error: any) {
          attemptCount++;
          console.error(`Connection error (Attempt ${attemptCount}/${MAX_RETRIES}):`, error);
  
          if (attemptCount < MAX_RETRIES) {
            setTimeout(connectWithRetry, 3000);
          } else if (isMounted) {
            setStatus("error");
            router.navigate("/error?error=Connection Failed&description=Unable to connect after multiple attempts.");
          }
        }
      };
  
      connectWithRetry();
    };
  
    attemptConnection();
  
    return () => {
      isMounted = false;
    };
  }, [getValue, ws, router]);

  if (status === "connecting" || (typeof status === "string" && status.startsWith("Retrying"))) {
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

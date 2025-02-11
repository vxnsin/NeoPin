import React, { useEffect } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import useThemeManager from "@/hooks/useThemeManager";
import { WebSocketProvider } from "@/context/WebSocket"; 

export default function RootLayout() {
  const theme = useThemeManager();
  
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
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.surface },
          animation: "fade"
        }}
      />
    </WebSocketProvider>
  );
}

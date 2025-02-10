import { Stack } from "expo-router";
import { useEffect } from "react";
import * as SplashScreen from "expo-splash-screen";
import useThemeManager from "@/hooks/useThemeManager";

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
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.surface },
      }}
    />
  );
}

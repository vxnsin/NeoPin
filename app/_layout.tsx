import { NavigationContainer } from '@react-navigation/native';
import { Stack } from "expo-router";
import { useThemeManager } from "../hooks/useThemeManager";

export default function RootLayout() {
  const theme = useThemeManager();

  return (
    <NavigationContainer theme={theme}>
      <Stack />
    </NavigationContainer>
  );
}

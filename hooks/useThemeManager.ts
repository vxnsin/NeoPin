import { useColorScheme } from "react-native";
import LightTheme from "@/themes/LightTheme";
import DarkTheme from "@/themes/DarkTheme";
import type { Theme } from "@/themes/Theme";

export default function useThemeManager(): Theme {
  return useColorScheme() === "dark" ? DarkTheme : LightTheme;
}

import React, { useEffect, useState } from "react";
import { useColorScheme } from "react-native";
import LightTheme from "../themes/LightTheme";
import DarkTheme from "../themes/DarkTheme";

const useThemeManager = () => {
  const colorScheme = useColorScheme();
  const [theme, setTheme] = useState(LightTheme);

  useEffect(() => {
    if (colorScheme === "dark") {
      setTheme(DarkTheme);
    } else {
      setTheme(LightTheme);
    }
  }, [colorScheme]);

  return theme;
};

export default useThemeManager;

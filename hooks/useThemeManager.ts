import { useSyncExternalStore } from "react";
import { Appearance, AppState } from "react-native";
import LightTheme from "@/themes/LightTheme";
import DarkTheme from "@/themes/DarkTheme";
import type { Theme } from "@/themes/Theme";
import { createSchemeStore, type Scheme } from "@/lib/scheme";

function asScheme(name: string | null | undefined): Scheme {
  return name === "dark" ? "dark" : "light";
}

const systemScheme = createSchemeStore({
  read: () => {
    // Following the system is the default anyway; setting it again makes React Native drop its
    // cached answer and ask the phone. React Native Web has no such call.
    if (typeof Appearance.setColorScheme === "function") Appearance.setColorScheme("auto");
    return asScheme(Appearance.getColorScheme());
  },
  onChange: (listener) => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => listener(asScheme(colorScheme)));
    return () => subscription.remove();
  },
  onForeground: (listener) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") listener();
    });
    return () => subscription.remove();
  },
});

export default function useThemeManager(): Theme {
  const scheme = useSyncExternalStore(systemScheme.subscribe, systemScheme.get);
  return scheme === "dark" ? DarkTheme : LightTheme;
}

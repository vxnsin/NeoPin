// useThemeManager.ts
import { useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, Theme as NavigationTheme } from '@react-navigation/native';

interface Theme extends NavigationTheme {
  colors: NavigationTheme['colors'] & {
    surface: string;
    onSurface: string;
    secondary: string;
    onSecondary: string;
  };
}

export function useThemeManager(): Theme {
  const colorScheme = useColorScheme();

  const lightTheme: Theme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      surface: '#FFFFFF',
      onSurface: '#d0d0d8',
      primary: '#000000',
      secondary: '#d3171e',
      onSecondary: '#FFFFFF',
      background: DefaultTheme.colors.background,
      card: DefaultTheme.colors.card,
      text: DefaultTheme.colors.text,
      border: DefaultTheme.colors.border,
      notification: DefaultTheme.colors.notification,
    },
  };

  const darkTheme: Theme = {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      surface: '#090a0d',
      onSurface: '#2c2d33',
      primary: '#FFFFFF',
      secondary: '#d3171e',
      onSecondary: '#FFFFFF',
      background: DarkTheme.colors.background,
      card: DarkTheme.colors.card,
      text: DarkTheme.colors.text,
      border: DarkTheme.colors.border,
      notification: DarkTheme.colors.notification,
    },
  };

  return colorScheme === 'dark' ? darkTheme : lightTheme;
}

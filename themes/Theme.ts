export interface ThemeColors {
  surface: string;
  onSurface: string;
  primary: string;
  secondary: string;
  onSecondary: string;
}

export interface Theme {
  isDark: boolean;
  colors: ThemeColors;
}

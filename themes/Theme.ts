export interface ThemeColors {
  surface: string;
  onSurface: string;
  primary: string;
  secondary: string;
  onSecondary: string;
  // Floating panels and sheets, quiet fills inside them, secondary text.
  raised: string;
  subtle: string;
  muted: string;
}

export interface Theme {
  isDark: boolean;
  colors: ThemeColors;
}

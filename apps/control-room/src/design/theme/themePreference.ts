export type ThemeMode = "dark" | "light";

export const DEFAULT_THEME_MODE: ThemeMode = "dark";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light";
}

export function resolveThemePreference(
  storedTheme: string | null | undefined,
  systemPrefersDark: boolean,
): ThemeMode {
  if (isThemeMode(storedTheme)) {
    return storedTheme;
  }

  return systemPrefersDark ? "dark" : "light";
}

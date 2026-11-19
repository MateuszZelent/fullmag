export type ThemeMode = "dark" | "light";
export type ThemePreference = ThemeMode | "system";

export const DEFAULT_THEME_MODE: ThemeMode = "dark";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";
export const THEME_STORAGE_KEY = "fullmag.control-room.theme";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light";
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return isThemeMode(value) || value === "system";
}

export function parseThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
}

export function resolveThemeMode(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ThemeMode {
  if (preference !== "system") {
    return preference;
  }

  return systemPrefersDark ? "dark" : "light";
}

export function resolveThemePreference(
  storedTheme: string | null | undefined,
  systemPrefersDark: boolean,
): ThemeMode {
  return resolveThemeMode(parseThemePreference(storedTheme), systemPrefersDark);
}

/**
 * Runs in the document head before the page body is parsed. Keep this in sync
 * with ThemeProvider's preference parser and preserve the existing storage key
 * so previously saved `dark` and `light` choices continue to work.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function () {
  var root = document.documentElement;
  var preference = ${JSON.stringify(DEFAULT_THEME_PREFERENCE)};
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (stored === "dark" || stored === "light" || stored === "system") {
      preference = stored;
    }
  } catch (_) {}

  var prefersDark = true;
  try {
    if (typeof window.matchMedia === "function") {
      prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
  } catch (_) {}

  var theme = preference === "system"
    ? (prefersDark ? "dark" : "light")
    : preference;
  root.setAttribute("data-theme-preference", preference);
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
})();`;

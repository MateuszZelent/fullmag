"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_THEME_MODE,
  resolveThemePreference,
  type ThemeMode,
} from "./themePreference";

const THEME_STORAGE_KEY = "fullmag.control-room.theme";

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readSystemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function persistTheme(theme: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme persistence is a preference, not a correctness dependency.
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_THEME_MODE;
    }

    return resolveThemePreference(readStoredTheme(), readSystemPrefersDark());
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function setTheme(nextTheme: ThemeMode): void {
    setThemeState(nextTheme);
    applyTheme(nextTheme);
    persistTheme(nextTheme);
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const themeContext = useContext(ThemeContext);

  if (!themeContext) {
    throw new Error("useTheme must be used within ThemeProvider.");
  }

  return themeContext;
}

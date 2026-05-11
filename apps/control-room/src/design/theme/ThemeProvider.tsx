"use client";

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  DEFAULT_THEME_MODE,
  resolveThemePreference,
  type ThemeMode,
} from "./themePreference";
import { THEME_TOGGLE_EVENT } from "./themeEvents";

const THEME_STORAGE_KEY = "fullmag.control-room.theme";

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const themeListeners = new Set<() => void>();
let currentTheme: ThemeMode = DEFAULT_THEME_MODE;

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

function emitThemeChange(): void {
  for (const listener of themeListeners) {
    listener();
  }
}

function getThemeSnapshot(): ThemeMode {
  return currentTheme;
}

function getServerThemeSnapshot(): ThemeMode {
  return DEFAULT_THEME_MODE;
}

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function setThemePreference(nextTheme: ThemeMode): void {
  if (currentTheme === nextTheme) {
    applyTheme(nextTheme);
    return;
  }

  currentTheme = nextTheme;
  applyTheme(nextTheme);
  persistTheme(nextTheme);
  emitThemeChange();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );

  useEffect(() => {
    const resolvedTheme = resolveThemePreference(
      readStoredTheme(),
      readSystemPrefersDark(),
    );
    setThemePreference(resolvedTheme);
  }, []);

  useEffect(() => {
    function handleThemeToggle() {
      setThemePreference(getThemeSnapshot() === "dark" ? "light" : "dark");
    }

    window.addEventListener(THEME_TOGGLE_EVENT, handleThemeToggle);
    return () => {
      window.removeEventListener(THEME_TOGGLE_EVENT, handleThemeToggle);
    };
  }, []);

  function setTheme(nextTheme: ThemeMode): void {
    setThemePreference(nextTheme);
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

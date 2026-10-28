"use client";

import {
  createContext,
  use,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveThemeMode,
  type ThemePreference,
  type ThemeMode,
} from "./themePreference";
import { THEME_TOGGLE_EVENT } from "./themeEvents";

interface ThemeSnapshot {
  theme: ThemeMode;
  preference: ThemePreference;
}

interface ThemeContextValue {
  theme: ThemeMode;
  preference: ThemePreference;
  setTheme: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const themeListeners = new Set<() => void>();

const SERVER_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: DEFAULT_THEME_MODE,
  preference: DEFAULT_THEME_PREFERENCE,
};

function isThemeMode(value: string | undefined): value is ThemeMode {
  return value === "dark" || value === "light";
}

function readDocumentThemeSnapshot(): ThemeSnapshot {
  if (typeof document === "undefined") {
    return SERVER_THEME_SNAPSHOT;
  }

  const root = document.documentElement;
  const preference = parseThemePreference(root.dataset.themePreference);
  const theme = isThemeMode(root.dataset.theme)
    ? root.dataset.theme
    : resolveThemeMode(preference, readSystemPrefersDark());

  return { theme, preference };
}

let currentSnapshot = readDocumentThemeSnapshot();

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

function applyTheme(snapshot: ThemeSnapshot): void {
  const root = document.documentElement;
  root.dataset.themePreference = snapshot.preference;
  root.dataset.theme = snapshot.theme;
  root.style.colorScheme = snapshot.theme;
}

function persistTheme(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme persistence is a preference, not a correctness dependency.
  }
}

function emitThemeChange(): void {
  for (const listener of themeListeners) {
    listener();
  }
}

function getThemeSnapshot(): ThemeSnapshot {
  return currentSnapshot;
}

function getServerThemeSnapshot(): ThemeSnapshot {
  return SERVER_THEME_SNAPSHOT;
}

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function updateThemeSnapshot(
  preference: ThemePreference,
  systemPrefersDark: boolean,
  shouldPersist: boolean,
): void {
  const nextSnapshot: ThemeSnapshot = {
    preference,
    theme: resolveThemeMode(preference, systemPrefersDark),
  };
  const changed =
    currentSnapshot.preference !== nextSnapshot.preference ||
    currentSnapshot.theme !== nextSnapshot.theme;

  currentSnapshot = nextSnapshot;
  applyTheme(nextSnapshot);
  if (shouldPersist) {
    persistTheme(preference);
  }
  if (changed) {
    emitThemeChange();
  }
}

function setThemePreference(preference: ThemePreference): void {
  updateThemeSnapshot(preference, readSystemPrefersDark(), true);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );

  useEffect(() => {
    updateThemeSnapshot(
      parseThemePreference(readStoredTheme()),
      readSystemPrefersDark(),
      false,
    );

    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) return;

    const handleSystemPreferenceChange = (event: MediaQueryListEvent) => {
      if (currentSnapshot.preference === "system") {
        updateThemeSnapshot("system", event.matches, false);
      }
    };
    mediaQuery.addEventListener("change", handleSystemPreferenceChange);
    return () => {
      mediaQuery.removeEventListener("change", handleSystemPreferenceChange);
    };
  }, []);

  useEffect(() => {
    function handleThemeToggle() {
      setThemePreference(currentSnapshot.theme === "dark" ? "light" : "dark");
    }

    window.addEventListener(THEME_TOGGLE_EVENT, handleThemeToggle);
    return () => {
      window.removeEventListener(THEME_TOGGLE_EVENT, handleThemeToggle);
    };
  }, []);

  const setTheme = (preference: ThemePreference) => setThemePreference(preference);

  return (
    <ThemeContext.Provider
      value={{
        theme: snapshot.theme,
        preference: snapshot.preference,
        setTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const themeContext = use(ThemeContext);

  if (!themeContext) {
    throw new Error("useTheme must be used within ThemeProvider.");
  }

  return themeContext;
}

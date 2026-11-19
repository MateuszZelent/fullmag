import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME_MODE,
  parseThemePreference,
  resolveThemePreference,
  type ThemeMode,
} from "./themePreference";

describe("theme preference", () => {
  it("uses the stored theme when it is valid", () => {
    expect(resolveThemePreference("light", true)).toBe("light");
    expect(resolveThemePreference("dark", false)).toBe("dark");
  });

  it("falls back to system preference for invalid or missing values", () => {
    expect(resolveThemePreference(null, true)).toBe("dark");
    expect(resolveThemePreference("auto", false)).toBe("light");
  });

  it("keeps explicit saved themes and supports a live system preference", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("system")).toBe("system");
    expect(resolveThemePreference("system", true)).toBe("dark");
    expect(resolveThemePreference("system", false)).toBe("light");
  });

  it("keeps a typed default for server-rendered markup", () => {
    const defaultTheme: ThemeMode = DEFAULT_THEME_MODE;

    expect(defaultTheme).toBe("dark");
  });
});

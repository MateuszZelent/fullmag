"use client";

import { Moon, Sun } from "lucide-react";

import type { ThemeMode } from "@/design/theme/themePreference";

import { Button } from "./Button";

interface ThemeSwitcherProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}

export function ThemeSwitcher({ theme, onThemeChange }: ThemeSwitcherProps) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? Sun : Moon;

  return (
    <Button
      aria-label={`Switch to ${nextTheme} theme`}
      className="fm-header__action-btn fm-theme-switcher"
      onClick={() => onThemeChange(nextTheme)}
      size="icon"
      title={`Switch to ${nextTheme} theme`}
      type="button"
      variant="ghost"
    >
      <Icon size={14} aria-hidden="true" />
    </Button>
  );
}

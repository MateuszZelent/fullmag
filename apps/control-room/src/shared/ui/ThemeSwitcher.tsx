"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme } from "@/design/theme/ThemeProvider";
import type { ThemeMode, ThemePreference } from "@/design/theme/themePreference";

import { Button } from "./Button";

const THEME_OPTIONS = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Monitor, label: "System", value: "system" },
  { icon: Moon, label: "Dark", value: "dark" },
] as const;

interface ThemeSwitcherProps {
  theme: ThemeMode;
  onThemeChange: (preference: ThemePreference) => void;
}

export function ThemeSwitcher({ theme, onThemeChange }: ThemeSwitcherProps) {
  const { preference } = useTheme();
  const preferenceLabel =
    preference === "system"
      ? `System (currently ${theme})`
      : preference === "dark"
        ? "Dark"
        : "Light";

  // Light / System / Dark as one segmented control (mockup header); the group
  // keeps the "Color theme: ..." label that tests and browser checks use.
  return (
    <div
      aria-label={`Color theme: ${preferenceLabel}`}
      className="fm-theme-switcher"
      role="radiogroup"
      title={`Color theme: ${preferenceLabel}`}
    >
      {THEME_OPTIONS.map(({ icon: OptionIcon, label, value }) => (
        <Button
          aria-checked={preference === value}
          aria-label={label}
          className="fm-theme-switcher__option"
          key={value}
          role="radio"
          size="icon"
          title={label}
          type="button"
          variant="ghost"
          onClick={() => onThemeChange(value)}
        >
          <OptionIcon size={13} aria-hidden="true" />
        </Button>
      ))}
    </div>
  );
}

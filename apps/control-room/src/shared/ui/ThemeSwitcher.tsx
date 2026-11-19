"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme } from "@/design/theme/ThemeProvider";
import type { ThemeMode, ThemePreference } from "@/design/theme/themePreference";

import { Button } from "./Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./DropdownMenu";

interface ThemeSwitcherProps {
  theme: ThemeMode;
  onThemeChange: (preference: ThemePreference) => void;
}

export function ThemeSwitcher({ theme, onThemeChange }: ThemeSwitcherProps) {
  const { preference } = useTheme();
  const Icon =
    preference === "system" ? Monitor : preference === "dark" ? Moon : Sun;
  const preferenceLabel =
    preference === "system"
      ? `System (currently ${theme})`
      : preference === "dark"
        ? "Dark"
        : "Light";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Color theme: ${preferenceLabel}`}
          className="fm-header__action-btn fm-theme-switcher"
          size="icon"
          title={`Color theme: ${preferenceLabel}`}
          type="button"
          variant="ghost"
        >
          <Icon size={14} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Color theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            if (value === "light" || value === "dark" || value === "system") {
              onThemeChange(value);
            }
          }}
        >
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

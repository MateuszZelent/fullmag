"use client";

import { useTheme } from "@/design/theme/ThemeProvider";

const MENU_ITEMS = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "simulation", label: "Simulation" },
  { id: "tools", label: "Tools" },
  { id: "help", label: "Help" },
] as const;

function ThemeToggleIcon({ theme }: { theme: "dark" | "light" }) {
  if (theme === "dark") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function AppMenuBar() {
  const { theme, setTheme } = useTheme();

  function handleThemeToggle() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  return (
    <header className="fm-header">
      <div className="fm-header__brand">
        <div className="fm-header__logo" aria-hidden="true" />
        <span className="fm-header__title">Fullmag</span>
      </div>

      <nav className="fm-header__nav" aria-label="Main menu">
        {MENU_ITEMS.map((item) => (
          <button
            key={item.id}
            className="fm-header__nav-item"
            type="button"
            aria-haspopup="true"
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="fm-header__spacer" />

      <div className="fm-header__session-indicator">
        <span
          className="fm-header__session-dot"
          data-status="connected"
          aria-label="Session connected"
        />
        <span>No session</span>
      </div>

      <div className="fm-header__separator" />

      <div className="fm-header__actions">
        <button
          className="fm-header__action-btn"
          type="button"
          onClick={handleThemeToggle}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          <ThemeToggleIcon theme={theme} />
        </button>
      </div>
    </header>
  );
}

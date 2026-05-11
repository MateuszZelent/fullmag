"use client";

import { ChevronDown, Search } from "lucide-react";

import { useTheme } from "@/design/theme/ThemeProvider";
import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";

import {
  APP_DROPDOWN_ITEMS,
  MAIN_MENUS,
  QUICK_ACTIONS,
  RUN_CONTROLS,
  type AppMenuNode,
  type HeaderQuickAction,
} from "./appMenuModel";

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

function MenuNode({ node }: { node: AppMenuNode }) {
  if (node.children?.length) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={node.disabled}>
          {node.icon}
          <span>{node.label}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {node.children.map((child) => (
            <MenuNode key={child.id} node={child} />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenuItem disabled={node.disabled}>
      {node.icon}
      <span>{node.label}</span>
      {node.shortcut ? (
        <span className="fm-dropdown-shortcut">{node.shortcut}</span>
      ) : null}
    </DropdownMenuItem>
  );
}

function HeaderDropdown({ menu }: { menu: AppMenuNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="fm-header__nav-item"
          size="sm"
          type="button"
          variant="ghost"
        >
          {menu.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{menu.label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {menu.children?.map((node) => (
          <MenuNode key={node.id} node={node} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QuickActionButton({ action }: { action: HeaderQuickAction }) {
  return (
    <Button
      className="fm-header__quick-action"
      disabled={action.disabled}
      size="sm"
      title={action.label}
      type="button"
      variant="ghost"
    >
      {action.icon}
      <span>{action.label}</span>
    </Button>
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
        <div className="fm-header__brand-copy">
          <span className="fm-header__title">Fullmag</span>
          <span className="fm-header__subtitle">Untitled problem</span>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="fm-header__app-trigger"
            size="sm"
            type="button"
            variant="secondary"
          >
            Fullmag
            <ChevronDown size={12} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Application</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {APP_DROPDOWN_ITEMS.map((node) => (
            <MenuNode key={node.id} node={node} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <nav className="fm-header__nav" aria-label="Main menu">
        {MAIN_MENUS.map((menu) => (
          <HeaderDropdown key={menu.id} menu={menu} />
        ))}
      </nav>

      <div className="fm-header__quick-actions">
        {QUICK_ACTIONS.map((action) => (
          <QuickActionButton key={action.id} action={action} />
        ))}
      </div>

      <label className="fm-header__search">
        <Search size={13} aria-hidden="true" />
        <input
          aria-label="Command search"
          placeholder="Command search (Ctrl+K)"
          readOnly
          type="text"
        />
      </label>

      <div className="fm-header__session-indicator">
        <span
          className="fm-header__session-dot"
          data-status="connected"
          aria-label="Session connected"
        />
        <span>Local API</span>
        <span className="fm-header__session-badge">idle</span>
      </div>

      <div className="fm-header__separator" />

      <div className="fm-header__run-controls" aria-label="Runtime controls">
        {RUN_CONTROLS.map((action) => (
          <Button
            key={action.id}
            className="fm-header__run-btn"
            data-run-control={action.id}
            disabled={action.disabled}
            size="icon"
            title={action.label}
            type="button"
            variant="ghost"
          >
            {action.icon}
          </Button>
        ))}
      </div>

      <div className="fm-header__separator" />

      <div className="fm-header__actions">
        <Button
          className="fm-header__action-btn"
          size="icon"
          type="button"
          variant="ghost"
          onClick={handleThemeToggle}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          <ThemeToggleIcon theme={theme} />
        </Button>
      </div>
    </header>
  );
}

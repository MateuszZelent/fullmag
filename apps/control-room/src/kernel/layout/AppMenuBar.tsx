"use client";

import { ChevronDown, Search } from "lucide-react";

import { useTheme } from "@/design/theme/ThemeProvider";
import { Button } from "@/shared/ui/Button";
import { ThemeSwitcher } from "@/shared/ui/ThemeSwitcher";
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
          placeholder="Command search (Ctrl+Shift+P)"
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
        <ThemeSwitcher theme={theme} onThemeChange={setTheme} />
      </div>
    </header>
  );
}

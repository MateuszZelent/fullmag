import { requestThemeToggle } from "@/design/theme/themeEvents";

import type { CommandContribution } from "../commands/commandTypes";

export const SHELL_COMMANDS: CommandContribution[] = [
  {
    id: "workspace.theme-toggle",
    title: "Toggle Theme",
    group: "workspace",
    category: "Window",
    scope: "global",
    shortcut: "Ctrl+Shift+T",
    run: () => {
      requestThemeToggle();
      return { status: "completed" };
    },
  },
  // ── Panel visibility toggles ──────────────────────────────────────────────
  {
    id: "panels:explorer:toggle",
    title: "Toggle Explorer",
    group: "layout",
    category: "View",
    scope: "global",
    isActive: (ctx) => ctx.layout?.get().panelVisible.left ?? true,
    run: (ctx) => {
      ctx.layout?.togglePanel("left");
      return { status: "completed" };
    },
  },
  {
    id: "panels:inspector:toggle",
    title: "Toggle Inspector",
    group: "layout",
    category: "View",
    scope: "global",
    isActive: (ctx) => ctx.layout?.get().panelVisible.right ?? true,
    run: (ctx) => {
      ctx.layout?.togglePanel("right");
      return { status: "completed" };
    },
  },
  {
    id: "panels:footer:toggle",
    title: "Toggle Footer",
    group: "layout",
    category: "View",
    scope: "global",
    isActive: (ctx) => ctx.layout?.get().panelVisible.bottom ?? true,
    run: (ctx) => {
      ctx.layout?.togglePanel("bottom");
      return { status: "completed" };
    },
  },
];

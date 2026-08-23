import { requestThemeToggle } from "@/design/theme/themeEvents";

import type { CommandContribution } from "../commands/commandTypes";

function disabledPlaceholder(
  id: string,
  title: string,
  category: string,
  shortcut?: string,
): CommandContribution {
  return {
    id,
    title,
    category,
    group: "workspace-placeholder",
    scope: "global",
    shortcut,
    isEnabled: () => false,
    disabledReason: () => `${title} is not implemented in frontend v2 yet.`,
    run: () => ({
      message: `${title} is not implemented in frontend v2 yet.`,
      status: "failed",
    }),
  };
}

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
  {
    id: "workspace.view-3d",
    title: "3D Workspace",
    group: "workspace",
    category: "View",
    scope: "global",
    shortcut: "1",
    run: (ctx) => {
      ctx.layout?.setActiveTab("view");
      ctx.layout?.setFocusedSlot("viewport-main");
      return { status: "completed" };
    },
  },
  {
    id: "workspace.focus-selection",
    title: "Focus Selection",
    group: "workspace",
    category: "View",
    scope: "selection",
    isEnabled: (ctx) => Boolean(ctx.selection?.get().nodeId),
    disabledReason: (ctx) =>
      ctx.selection?.get().nodeId ? null : "No workspace selection is active.",
    run: (ctx) => {
      ctx.layout?.setActiveTab("view");
      ctx.layout?.setFocusedSlot("viewport-main");
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
  disabledPlaceholder("workspace.preferences", "Preferences", "Application"),
  disabledPlaceholder("workspace.docs", "Physics Documentation", "Application"),
  disabledPlaceholder("workspace.about", "About Fullmag", "Application"),
  {
    id: "workspace.new-problem",
    title: "New Problem",
    group: "workspace",
    category: "File",
    scope: "global",
    shortcut: "Ctrl+N",
    run: (ctx) => {
      ctx.bus?.emit("workspace:new-problem-requested", {
        source:
          ctx.source === "shortcut"
            ? "shortcut"
            : ctx.source === "menu"
              ? "menu"
              : "workspace",
      });
      return { status: "completed" };
    },
  },
  disabledPlaceholder("workspace.save-sync", "Save / Sync", "File", "Ctrl+S"),
  {
    id: "workspace.export-python",
    title: "Export Python DSL",
    group: "workspace",
    category: "File",
    scope: "workspace",
    isEnabled: (ctx) => Boolean(ctx.api),
    disabledReason: (ctx) =>
      ctx.api ? null : "Export Python DSL requires an active workspace API.",
    run: async (ctx) => {
      if (!ctx.api) {
        return {
          message: "Export Python DSL requires an active workspace API.",
          status: "failed",
        };
      }
      await ctx.api.model.syncAuthoringScript({});
      const script = await ctx.api.model.authoringScript();
      if (typeof document !== "undefined") {
        const blob = new Blob([script.source], { type: "text/x-python;charset=utf-8" });
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.download = script.script_path.split(/[\\/]/).pop() || "fullmag-study.py";
        anchor.href = href;
        anchor.click();
        URL.revokeObjectURL(href);
      }
      return {
        message: `Canonical Python exported from ${script.script_path}.`,
        status: "completed",
      };
    },
  },
  disabledPlaceholder("workspace.undo", "Undo", "Edit", "Ctrl+Z"),
  disabledPlaceholder("workspace.redo", "Redo", "Edit", "Ctrl+Y"),
  disabledPlaceholder("workspace.view-2d", "2D Slice Workspace", "View", "2"),
  disabledPlaceholder("execution.fdm-cpu", "FDM CPU", "Simulation"),
  disabledPlaceholder("execution.fdm-gpu", "FDM GPU", "Simulation"),
  disabledPlaceholder("execution.fem-cpu", "FEM CPU", "Simulation"),
  disabledPlaceholder("workspace.diagnostics", "Diagnostics", "Tools"),
  disabledPlaceholder("workspace.api-console", "API Console", "Tools"),
  disabledPlaceholder("workspace.script-view", "Script View", "Tools"),
  disabledPlaceholder("workspace.search-docs", "Search Docs", "Help"),
  disabledPlaceholder("workspace.reference", "Reference", "Help"),
  disabledPlaceholder("workspace.about-help", "About", "Help"),
];

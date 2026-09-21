import { requestThemeToggle } from "@/design/theme/themeEvents";

import type { CommandContribution } from "../commands/commandTypes";
import { pickProjectArchive } from "../persistence/ProjectDocumentController";

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

function projectDocumentUnavailableReason(
  context: Parameters<NonNullable<CommandContribution["isEnabled"]>>[0],
): string | null {
  return context.projectDocument
    ? null
    : "Project document lifecycle is unavailable in this shell.";
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
  {
    id: "workspace.new-project",
    title: "New Project",
    group: "workspace-document",
    category: "File",
    scope: "global",
    shortcut: "Ctrl+Shift+N",
    isEnabled: (context) => projectDocumentUnavailableReason(context) === null,
    disabledReason: projectDocumentUnavailableReason,
    run: async (context) => {
      if (!context.projectDocument) {
        return {
          message: projectDocumentUnavailableReason(context) ?? "Project document lifecycle is unavailable.",
          status: "failed",
        };
      }
      const input = context.input as { name?: string } | null | undefined;
      const promptedName =
        input?.name ??
        (typeof window === "undefined" || typeof window.prompt !== "function"
          ? "Untitled project"
          : window.prompt("Project name", "Untitled project"));
      if (promptedName === null) {
        return { message: "Project creation cancelled.", status: "cancelled" };
      }
      const resource = await context.projectDocument.create(promptedName);
      return {
        message: `Created project ${resource.name}.`,
        status: "completed",
      };
    },
  },
  {
    id: "workspace.open-project",
    title: "Open Project",
    group: "workspace-document",
    category: "File",
    scope: "global",
    shortcut: "Ctrl+O",
    isEnabled: (context) => projectDocumentUnavailableReason(context) === null,
    disabledReason: projectDocumentUnavailableReason,
    run: async (context) => {
      if (!context.projectDocument) {
        return {
          message: projectDocumentUnavailableReason(context) ?? "Project document lifecycle is unavailable.",
          status: "failed",
        };
      }
      const input = context.input as
        | { bytes: Uint8Array; fileName: string; hostPath?: string }
        | null
        | undefined;
      const source = input ?? (await pickProjectArchive());
      if (!source) {
        return { message: "No project file selected.", status: "cancelled" };
      }
      const resource = await context.projectDocument.open(source);
      return {
        message: `Opened project ${resource.name}.`,
        status: "completed",
      };
    },
  },
  {
    id: "workspace.save-project",
    title: "Save Project",
    group: "workspace-document",
    category: "File",
    scope: "global",
    shortcut: "Ctrl+S",
    isEnabled: (context) => Boolean(context.projectDocument?.canSave()),
    disabledReason: (context) => {
      if (!context.projectDocument) return projectDocumentUnavailableReason(context);
      if (context.projectDocument.canSave()) return null;
      return "Open a writable project before saving.";
    },
    run: async (context) => {
      if (!context.projectDocument) {
        return {
          message: projectDocumentUnavailableReason(context) ?? "Project document lifecycle is unavailable.",
          status: "failed",
        };
      }
      await context.projectDocument.save();
      return {
        message:
          typeof window !== "undefined" &&
          typeof window.__TAURI__?.core?.invoke === "function"
            ? "Project saved to the host filesystem."
            : "Project archive downloaded.",
        status: "completed",
      };
    },
  },
  {
    id: "workspace.close-project",
    title: "Close Project",
    group: "workspace-document",
    category: "File",
    scope: "global",
    shortcut: "Ctrl+W",
    isEnabled: (context) => {
      const state = context.projectDocument?.getSnapshot().state;
      return state === "ready" || state === "error";
    },
    disabledReason: (context) =>
      context.projectDocument?.getSnapshot().state === "ready" ||
      context.projectDocument?.getSnapshot().state === "error"
        ? null
        : "No project document is open.",
    run: (context) => {
      if (!context.projectDocument) {
        return {
          message: projectDocumentUnavailableReason(context) ?? "Project document lifecycle is unavailable.",
          status: "failed",
        };
      }
      const input = context.input as { discardChanges?: boolean } | null | undefined;
      const closed = context.projectDocument.close(input?.discardChanges ?? false);
      return closed
        ? { message: "Project closed.", status: "completed" }
        : { message: "Project close cancelled.", status: "cancelled" };
    },
  },
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

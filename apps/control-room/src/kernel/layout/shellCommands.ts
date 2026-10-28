import { requestThemeToggle } from "@/design/theme/themeEvents";

import { homeView } from "./homeView";

import type { CommandContext, CommandContribution } from "../commands/commandTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import { applyAuthoringHistoryWorkspaceTransition } from "../authoring/authoringHistoryWorkspaceRestore";
import { pickProjectArchive } from "../persistence/ProjectDocumentController";

function canonicalCopyFileName(scriptPath: string): string {
  const name = scriptPath.split(/[\\/]/).pop() || "fullmag-study.py";
  return name.endsWith(".canonical.py")
    ? name
    : `${name.replace(/\.py$/, "")}.canonical.py`;
}

function exportPythonDraftBlockReason(ctx: CommandContext): string | null {
  const transition = ctx.pendingForms?.getTransitionSnapshot();
  if (!transition) return null;
  if (transition.applyingOwnerCount > 0 || transition.preparing) {
    return "Inspector changes are being applied. Save the canonical copy after they finish so the file matches the saved scene.";
  }
  if (transition.dirtyOwnerCount > 0) {
    return "Inspector has unapplied changes that would not be in the exported file. Apply or Reset them first.";
  }
  return null;
}

function currentSceneRevision(ctx: CommandContext): number | null {
  const status = ctx.resourceData?.[SESSION_STATUS_RESOURCE_KEY] as
    | { resources?: { scene_revision?: unknown } }
    | null
    | undefined;
  const revision = status?.resources?.scene_revision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : null;
}

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

function authoringHistoryUnavailableReason(
  context: Parameters<NonNullable<CommandContribution["isEnabled"]>>[0],
): string | null {
  return context.authoringHistory
    ? null
    : "Authoring history is unavailable in this shell.";
}

function pendingFormUnavailableReason(
  context: Parameters<NonNullable<CommandContribution["isEnabled"]>>[0],
): string | null {
  return context.pendingForms
    ? null
    : "Inspector pending-form registry is unavailable in this shell.";
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
    id: "workspace.home",
    title: "Start screen",
    group: "workspace",
    category: "View",
    scope: "global",
    run: () => {
      homeView.open();
      return { status: "completed" };
    },
  },
  {
    id: "workspace.return-to-workspace",
    title: "Return to workspace",
    group: "workspace",
    category: "View",
    scope: "global",
    isEnabled: () => homeView.isOpen(),
    disabledReason: () => homeView.isOpen() ? null : "The start screen is not open.",
    run: () => {
      homeView.close();
      return { status: "completed" };
    },
  },
  {
    id: "workspace.new-problem",
    title: "New Problem",
    group: "workspace",
    category: "File",
    scope: "global",
    shortcut: "Ctrl+N",
    run: (ctx) => {
      const requested = (ctx.input as { solver?: unknown } | null | undefined)?.solver;
      ctx.bus?.emit("workspace:new-problem-requested", {
        source:
          ctx.source === "shortcut"
            ? "shortcut"
            : ctx.source === "menu"
              ? "menu"
              : "workspace",
        ...(requested === "FDM" || requested === "FEM" ? { solver: requested } : {}),
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
      context.authoringHistory?.clear();
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
      context.authoringHistory?.clear();
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
      if (closed) context.authoringHistory?.clear();
      return closed
        ? { message: "Project closed.", status: "completed" }
        : { message: "Project close cancelled.", status: "cancelled" };
    },
  },
  {
    id: "workspace.export-python",
    title: "Save canonical copy as…",
    group: "workspace",
    category: "File",
    scope: "workspace",
    isEnabled: (ctx) => Boolean(ctx.api) && exportPythonDraftBlockReason(ctx) === null,
    disabledReason: (ctx) =>
      ctx.api
        ? exportPythonDraftBlockReason(ctx)
        : "Save canonical copy requires an active workspace API.",
    run: async (ctx) => {
      if (!ctx.api) {
        return {
          message: "Save canonical copy requires an active workspace API.",
          status: "failed",
        };
      }
      // Drafts are never applied implicitly: the file must match the saved
      // scene, so dirty or applying Inspector forms block the export.
      const draftBlock = exportPythonDraftBlockReason(ctx);
      if (draftBlock) {
        return { message: draftBlock, status: "failed" };
      }
      const requestOptions = ctx.sessionScopeKey
        ? { sessionScopeKey: ctx.sessionScopeKey }
        : undefined;
      const expectedSceneRevision = currentSceneRevision(ctx);
      // The API writes the canonical script to a managed copy when the session
      // script is a user file; the user's own source is never overwritten.
      // The sync response carries the source rendered from one scene
      // revision, so no second GET can mix revisions.
      const sync = await ctx.api.model.syncAuthoringScript(
        expectedSceneRevision === null
          ? {}
          : { expected_scene_revision: expectedSceneRevision },
        requestOptions,
      );
      if (typeof sync.source !== "string") {
        return {
          message:
            "Canonical copy was not saved: the API did not return the rendered source for this scene revision.",
          status: "failed",
        };
      }
      if (typeof document !== "undefined") {
        const blob = new Blob([sync.source], { type: "text/x-python;charset=utf-8" });
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.download = canonicalCopyFileName(sync.script_path);
        anchor.href = href;
        anchor.click();
        URL.revokeObjectURL(href);
      }
      const revisionNote =
        typeof sync.scene_revision === "number"
          ? ` Scene revision ${sync.scene_revision}.`
          : "";
      const fidelityNote = ` Round-trip fidelity: ${!sync.fidelity || sync.fidelity === "not_checked" ? "not checked" : sync.fidelity}.`;
      return {
        message: (sync.source_script_modified
          ? `Canonical Python saved from ${sync.script_path}.`
          : `Canonical copy saved; your script was not modified (managed copy: ${sync.script_path}).`) +
          revisionNote + fidelityNote,
        status: "completed",
      };
    },
  },
  {
    id: "workspace.apply-inspector",
    title: "Apply Inspector Changes",
    group: "workspace-authoring",
    category: "Edit",
    scope: "selection",
    shortcut: "Ctrl+Shift+Enter",
    isEnabled: (context) => context.pendingForms?.canApply() ?? false,
    disabledReason: (context) => {
      const unavailable = pendingFormUnavailableReason(context);
      if (unavailable) return unavailable;
      const snapshot = context.pendingForms?.getSnapshot();
      if (!snapshot?.active) return "No Inspector form is active.";
      if (snapshot.lockReason) return snapshot.lockReason;
      if (snapshot.applyBlockReason) return snapshot.applyBlockReason;
      if (snapshot.applying) return "Inspector changes are already being applied.";
      if (!snapshot.dirty) return "There are no unapplied Inspector changes.";
      if (!snapshot.valid) return "Resolve Inspector validation errors before applying.";
      return null;
    },
    run: async (context) => {
      if (!context.pendingForms) {
        return {
          message: pendingFormUnavailableReason(context) ?? "Inspector pending-form registry is unavailable.",
          status: "failed",
        };
      }
      return context.pendingForms.apply();
    },
  },
  {
    id: "workspace.reset-inspector",
    title: "Reset Inspector Changes",
    group: "workspace-authoring",
    category: "Edit",
    scope: "selection",
    isEnabled: (context) => context.pendingForms?.canReset() ?? false,
    disabledReason: (context) => {
      const unavailable = pendingFormUnavailableReason(context);
      if (unavailable) return unavailable;
      const snapshot = context.pendingForms?.getSnapshot();
      if (!snapshot?.active) return "No Inspector form is active.";
      if (snapshot.applying) return "Inspector changes are already being applied.";
      return snapshot.canReset ? null : "There are no unapplied Inspector changes.";
    },
    run: async (context) => {
      if (!context.pendingForms) {
        return {
          message: pendingFormUnavailableReason(context) ?? "Inspector pending-form registry is unavailable.",
          status: "failed",
        };
      }
      return context.pendingForms.reset();
    },
  },
  {
    id: "workspace.undo",
    title: "Undo",
    group: "workspace-authoring",
    category: "Edit",
    scope: "global",
    shortcut: "Ctrl+Z",
    isEnabled: (context) =>
      context.authoringHistory?.canUndo() ?? false,
    disabledReason: (context) => {
      const unavailable = authoringHistoryUnavailableReason(context);
      if (unavailable) return unavailable;
      return context.authoringHistory?.canUndo()
        ? null
        : "There is no committed authoring change to undo.";
    },
    run: async (context) => {
      if (!context.authoringHistory) {
        return {
          message: authoringHistoryUnavailableReason(context) ?? "Authoring history is unavailable.",
          status: "failed",
        };
      }
      return context.authoringHistory.undo(context.sessionScopeKey, (transition) => {
        if (context.isCurrentSessionScope?.() === false) return;
        applyAuthoringHistoryWorkspaceTransition(context, transition);
      });
    },
  },
  {
    id: "workspace.redo",
    title: "Redo",
    group: "workspace-authoring",
    category: "Edit",
    scope: "global",
    shortcut: "Ctrl+Y",
    isEnabled: (context) =>
      context.authoringHistory?.canRedo() ?? false,
    disabledReason: (context) => {
      const unavailable = authoringHistoryUnavailableReason(context);
      if (unavailable) return unavailable;
      return context.authoringHistory?.canRedo()
        ? null
        : "There is no undone authoring change to redo.";
    },
    run: async (context) => {
      if (!context.authoringHistory) {
        return {
          message: authoringHistoryUnavailableReason(context) ?? "Authoring history is unavailable.",
          status: "failed",
        };
      }
      return context.authoringHistory.redo(context.sessionScopeKey, (transition) => {
        if (context.isCurrentSessionScope?.() === false) return;
        applyAuthoringHistoryWorkspaceTransition(context, transition);
      });
    },
  },
  disabledPlaceholder("workspace.view-2d", "2D Slice Workspace", "View", "2"),
  disabledPlaceholder("execution.fdm-cpu", "FDM CPU", "Simulation"),
  disabledPlaceholder("execution.fdm-gpu", "FDM GPU", "Simulation"),
  disabledPlaceholder("execution.fem-cpu", "FEM CPU", "Simulation"),
  disabledPlaceholder("workspace.diagnostics", "Diagnostics", "Tools"),
  disabledPlaceholder("workspace.api-console", "API Console", "Tools"),
  disabledPlaceholder("workspace.script-view", "Script View", "Tools"),
];

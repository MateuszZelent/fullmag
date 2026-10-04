import type {
  CommandContext,
  CommandContribution,
  CommandResult,
} from "@/kernel/commands/commandTypes";
import { homeView } from "@/kernel/layout/homeView";

import {
  startScreenStore,
  type SelectionActionKind,
  type StartScreenHost,
  type StartSection,
} from "./startScreenState";
import type { SolverKind } from "./types";

const NOT_SHOWING = "The start screen is not showing.";

interface StartAction {
  readonly target: string;
  readonly input: unknown;
  readonly createsProblem: boolean;
}

/** Start actions delegate to existing workspace commands; they never fork them. */
const START_ACTIONS: Readonly<Record<string, StartAction>> = {
  "start.new-fdm": {
    target: "workspace.new-problem",
    input: { solver: "FDM" satisfies SolverKind },
    createsProblem: true,
  },
  "start.new-fem": {
    target: "workspace.new-problem",
    input: { solver: "FEM" satisfies SolverKind },
    createsProblem: true,
  },
  "start.browse": {
    target: "workspace.open-project",
    input: undefined,
    createsProblem: false,
  },
};

/**
 * Shared by the commands (reading the attached host) and by the tiles, which
 * pass their own host so the very first paint already shows real enablement.
 */
export function startActionDisabledReason(
  commandId: string,
  host: StartScreenHost | null,
  context: CommandContext,
): string | null {
  if (!host) return NOT_SHOWING;
  const action = START_ACTIONS[commandId];
  if (!action) return null;
  if (action.createsProblem && host.createProblemDisabledReason) {
    return host.createProblemDisabledReason;
  }
  if (host.isEnabled(action.target, context)) return null;
  return host.disabledReason(action.target, context) ?? "This action is unavailable right now.";
}

function navigationCommand(
  id: string,
  title: string,
  section: StartSection,
  shortcut?: string,
): CommandContribution {
  const reason = () => (startScreenStore.getSnapshot().host ? null : NOT_SHOWING);
  return {
    id,
    title,
    group: "start-navigation",
    category: "Start",
    // Workspace scope outranks the global File shortcuts (Ctrl+N/O, Ctrl+Shift+N)
    // only while these commands are enabled, which is only on the start screen.
    scope: "workspace",
    shortcut,
    isEnabled: () => reason() === null,
    disabledReason: reason,
    run: () => {
      const blocked = reason();
      if (blocked) return { message: blocked, status: "failed" };
      startScreenStore.setSection(section);
      return { status: "completed" };
    },
  };
}

function actionCommand(id: string, title: string, shortcut: string): CommandContribution {
  const action = START_ACTIONS[id];
  if (!action) throw new Error(`Unknown start action ${id}.`);
  const reason = (context: CommandContext) =>
    startActionDisabledReason(id, startScreenStore.getSnapshot().host, context);
  return {
    id,
    title,
    group: "start-actions",
    category: "Start",
    scope: "workspace",
    shortcut,
    isEnabled: (context) => reason(context) === null,
    disabledReason: reason,
    run: (context): CommandResult | Promise<CommandResult> => {
      const host = startScreenStore.getSnapshot().host;
      const blocked = reason(context);
      if (!host || blocked) return { message: blocked ?? NOT_SHOWING, status: "failed" };
      return host.execute(action.target, { ...context, input: action.input });
    },
  };
}

function listCommand(
  id: string,
  title: string,
  run: () => void,
  shortcut?: string,
): CommandContribution {
  // These act on the recent list, which exists only on the Home section.
  const reason = () => {
    const snapshot = startScreenStore.getSnapshot();
    if (!snapshot.host) return NOT_SHOWING;
    return snapshot.section === "home" ? null : "Open the Home section first.";
  };
  return {
    id,
    title,
    group: "start-list",
    category: "Start",
    scope: "workspace",
    shortcut,
    isEnabled: () => reason() === null,
    disabledReason: reason,
    run: () => {
      const blocked = reason();
      if (blocked) return { message: blocked, status: "failed" };
      run();
      return { status: "completed" };
    },
  };
}

/** Acts on the project selected in the recent list, so it needs one. */
function selectionCommand(
  id: string,
  title: string,
  kind: SelectionActionKind,
  shortcut?: string,
): CommandContribution {
  const reason = () => {
    const snapshot = startScreenStore.getSnapshot();
    if (!snapshot.host) return NOT_SHOWING;
    if (snapshot.section !== "home") return "Open the Home section first.";
    return snapshot.selectedProjectId ? null : "Select a project in the list first.";
  };
  return {
    id,
    title,
    group: "start-list",
    category: "Start",
    scope: "workspace",
    shortcut,
    isEnabled: () => reason() === null,
    disabledReason: reason,
    run: () => {
      const blocked = reason();
      if (blocked) return { message: blocked, status: "failed" };
      startScreenStore.requestSelectionAction(kind);
      return { status: "completed" };
    },
  };
}

export const START_COMMANDS: readonly CommandContribution[] = [
  navigationCommand("start.section.home", "Start: Home", "home", "Ctrl+1"),
  navigationCommand("start.section.templates", "Start: Templates", "templates", "Ctrl+2"),
  navigationCommand("start.section.import", "Start: Import", "import", "Ctrl+3"),
  navigationCommand("start.section.learn", "Start: Learn", "learn", "Ctrl+4"),
  navigationCommand("start.section.docs", "Start: Documentation", "docs"),
  navigationCommand("start.section.settings", "Start: Settings", "settings", "Ctrl+,"),
  navigationCommand("start.section.about", "Start: About", "about"),
  navigationCommand("start.templates", "Browse templates", "templates", "Ctrl+T"),
  navigationCommand("start.import", "Import model", "import", "Ctrl+I"),
  actionCommand("start.new-fdm", "New FDM simulation", "Ctrl+N"),
  actionCommand("start.new-fem", "New FEM simulation", "Ctrl+Shift+N"),
  actionCommand("start.browse", "Open project…", "Ctrl+O"),
  listCommand("start.search", "Search recent projects", () => startScreenStore.requestSearchFocus()),
  selectionCommand("start.open-selected", "Open selected project", "open"),
  selectionCommand("start.pin-selected", "Pin or unpin selected project", "pin"),
  selectionCommand("start.remove-selected", "Remove selected project from recent", "remove"),
  listCommand("start.rebuild-index", "Rebuild project index", () => startScreenStore.requestRebuild()),
  {
    id: "workspace.search-docs",
    title: "Search Docs",
    group: "workspace",
    category: "Help",
    scope: "global",
    shortcut: "F1",
    // Documentation opens as an overlay so the workspace remains mounted.
    run: () => {
      startScreenStore.requestDocs();
      homeView.open();
      return { status: "completed" };
    },
  },
  {
    id: "workspace.reference",
    title: "Reference",
    group: "workspace",
    category: "Help",
    scope: "global",
    // The Python API reference is where a user looks up a parameter.
    run: () => {
      startScreenStore.requestDocs("python-api/index.html");
      homeView.open();
      return { status: "completed" };
    },
  },
  {
    id: "workspace.about-help",
    title: "About",
    group: "workspace",
    category: "Help",
    scope: "global",
    run: () => {
      startScreenStore.setSection("about");
      homeView.open();
      return { status: "completed" };
    },
  },
  listCommand("start.open-recent", "Open recent project…", () => startScreenStore.requestListFocus(), "Ctrl+Alt+O"),
];

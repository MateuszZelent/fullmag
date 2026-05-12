/**
 * P3 — Command Registry
 *
 * Central registry for all UI commands. Ribbon, tree context menu,
 * viewport toolbar, and keyboard shortcuts all resolve commands
 * from the same registry. Each command declares visibility, enabled
 * state (with disabled reason), active state, and execution.
 */

import type { SelectionState, SelectionTarget } from "../model/selection";
import type { ViewportInteractionState } from "../model/viewportInteraction";
import type { DirtyGraphState } from "../model/dirtyGraph";
import { INITIAL_DIRTY_GRAPH } from "../model/dirtyGraph";
import type { RunGateState } from "../model/runGate";

// ── Command context ───────────────────────────────────────────

export interface CommandContext {
  selection: SelectionState;
  viewport: ViewportInteractionState;
  dirtyGraph: DirtyGraphState;
  runGate: RunGateState;
}

// ── Command state result ──────────────────────────────────────

export interface CommandState {
  enabled: boolean;
  active?: boolean;
  reason?: string;
  badge?: string;
}

// ── Command definition ────────────────────────────────────────

export interface CommandDefinition<TArgs = void> {
  id: string;
  label: string;
  icon?: string;
  group: string;
  shortcut?: string;
  isVisible: (ctx: CommandContext) => boolean;
  getState: (ctx: CommandContext) => CommandState;
  execute: (ctx: CommandContext, args?: TArgs) => Promise<void> | void;
}

// ── Registry ──────────────────────────────────────────────────

const commands = new Map<string, CommandDefinition<unknown>>();

export function registerCommand<TArgs = void>(def: CommandDefinition<TArgs>): void {
  commands.set(def.id, def as CommandDefinition<unknown>);
}

export function unregisterCommand(id: string): void {
  commands.delete(id);
}

export function getCommand(id: string): CommandDefinition<unknown> | undefined {
  return commands.get(id);
}

export function getAllCommands(): CommandDefinition<unknown>[] {
  return Array.from(commands.values());
}

export function getCommandsForGroup(group: string): CommandDefinition<unknown>[] {
  return Array.from(commands.values()).filter((c) => c.group === group);
}

/**
 * Get all commands visible and relevant for a given selection target.
 */
export function getCommandsForContext(ctx: CommandContext): CommandDefinition<unknown>[] {
  return Array.from(commands.values()).filter((c) => c.isVisible(ctx));
}

/**
 * Build a CommandContext from the current store state.
 * Lazy import avoids circular dependencies — the stores are
 * only accessed at call time, not at import time.
 */
function buildCurrentContext(): CommandContext {
  // Dynamic import from sibling store — safe because commands
  // are only executed after stores are initialised.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useInteractionStore } = require("../store/useInteractionStore") as {
    useInteractionStore: { getState: () => { selection: CommandContext["selection"]; viewport: CommandContext["viewport"] } };
  };
  const interactionState = useInteractionStore.getState();

  let dirtyGraph: CommandContext["dirtyGraph"] | undefined;
  let runGate: CommandContext["runGate"] | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useDirtyGraphStore } = require("../store/useDirtyGraphStore") as {
      useDirtyGraphStore: { getState: () => { dirtyGraph: CommandContext["dirtyGraph"]; runGate: CommandContext["runGate"] } };
    };
    const dgState = useDirtyGraphStore.getState();
    dirtyGraph = dgState.dirtyGraph;
    runGate = dgState.runGate;
  } catch {
    // DirtyGraphStore may not exist yet — use safe defaults
  }

  return {
    selection: interactionState.selection,
    viewport: interactionState.viewport,
    dirtyGraph: dirtyGraph ?? INITIAL_DIRTY_GRAPH,
    runGate: runGate ?? { canRun: false, canRelax: false, blockers: [] },
  };
}

/**
 * Execute a command by ID.
 *
 * If `ctx` is omitted the current store state is used automatically.
 */
export async function executeCommand(
  id: string,
  ctxOrArgs?: CommandContext | unknown,
  args?: unknown,
): Promise<void> {
  // Resolve overloaded arguments
  let ctx: CommandContext;
  let effectiveArgs: unknown;
  if (
    ctxOrArgs &&
    typeof ctxOrArgs === "object" &&
    "selection" in ctxOrArgs &&
    "viewport" in ctxOrArgs
  ) {
    ctx = ctxOrArgs as CommandContext;
    effectiveArgs = args;
  } else {
    ctx = buildCurrentContext();
    effectiveArgs = ctxOrArgs;
  }

  const cmd = commands.get(id);
  if (!cmd) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`[CommandRegistry] Unknown command: ${id}`);
    }
    return;
  }
  const state = cmd.getState(ctx);
  if (!state.enabled) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`[CommandRegistry] Command disabled: ${id} — ${state.reason}`);
    }
    return;
  }
  await cmd.execute(ctx, effectiveArgs);
}

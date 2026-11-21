import type { CommandContext, CommandContribution, CommandId } from "@/kernel/commands/commandTypes";
import type { CommandActiveResource } from "@/kernel/commands/commandTypes";
import { isProjectWorkspaceCommand } from "@/kernel/commands/projectWorkspaceCommandPolicy";
import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import type { CommandRegistry } from "@/kernel/commands/CommandRegistry";

export function filterPaletteCommands(
  commands: readonly CommandContribution[],
  query: string,
): CommandContribution[] {
  const paletteCommands = commands.filter((command) => !command.requiresInput);
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return [...paletteCommands];

  return paletteCommands.filter((command) => {
    const haystack = [
      command.id,
      command.title,
      command.group,
      command.category,
      command.shortcut,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function executePaletteCommand(
  commands: CommandRegistry,
  commandId: CommandId,
  context: CommandContext,
): Promise<unknown> {
  return commands.execute(commandId, context);
}

export function paletteCommandResourceData(
  runtimeResourceData: Readonly<Record<string, unknown>>,
  visualizationState: unknown,
): Readonly<Record<string, unknown>> {
  return {
    ...runtimeResourceData,
    [VISUALIZATION_STATE_PATH]: visualizationState,
  };
}

/** Mirrors the no-session menu bar: creating a problem needs confirmed absence. */
export function projectWorkspacePaletteCommands(
  commands: readonly CommandContribution[],
  canCreateProblem: boolean,
): CommandContribution[] {
  return commands.filter(
    (command) =>
      isProjectWorkspaceCommand(command.id) &&
      (canCreateProblem || command.id !== "workspace.new-problem"),
  );
}

export interface PaletteCommandItem {
  active: boolean;
  activeResource: CommandActiveResource | null;
  command: CommandContribution;
  disabled: boolean;
  disabledReason: string | null;
}

export function resolvePaletteCommandItems(
  commands: readonly CommandContribution[],
  context: CommandContext | null,
): PaletteCommandItem[] {
  return commands.map((command) => {
    const disabled = context ? command.isEnabled?.(context) === false : false;
    const active = context ? command.isActive?.(context) === true : false;
    return {
      active,
      activeResource:
        active && context ? command.activeResource?.(context) ?? null : null,
      command,
      disabled,
      disabledReason:
        disabled && context ? command.disabledReason?.(context) ?? null : null,
    };
  });
}

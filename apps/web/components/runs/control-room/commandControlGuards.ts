export interface CommandBlockReasonContext {
  interactiveEnabled: boolean;
  runtimeCanAcceptCommands: boolean;
  commandBusy: boolean;
  commandMessage: string | null;
  workspaceStatus: string;
}

export type SolverControlAction = "run" | "pause" | "stop" | "skip";

function formatWorkspaceStatus(status: string): string {
  return status.replace(/_/g, " ");
}

export function commandBlockedReason(
  ctx: CommandBlockReasonContext,
  action: SolverControlAction,
  builderRunBlocked: boolean,
): string | null {
  if (!ctx.interactiveEnabled) {
    return "Solver commands are disabled because this workspace is not running in interactive mode.";
  }
  if (!ctx.runtimeCanAcceptCommands) {
    return "Solver runtime is busy and cannot accept commands yet.";
  }
  if (ctx.commandBusy) {
    return ctx.commandMessage ?? "A solver command is already being sent.";
  }
  if (action === "run" && builderRunBlocked) {
    return "Compute is blocked because the Geometry builder has changes that must be built or validated first.";
  }

  const status = formatWorkspaceStatus(ctx.workspaceStatus);
  if (action === "run") {
    return `Compute is only available when the workspace is waiting for compute, awaiting a command, or paused. Current status: ${status}.`;
  }
  if (action === "pause") {
    return `Pause is only available while the solver is running. Current status: ${status}.`;
  }
  if (action === "stop") {
    return `Stop is only available while the solver is running, paused, or waiting for compute. Current status: ${status}.`;
  }
  return `Skip is only available while the solver is running or paused. Current status: ${status}.`;
}

export function resolveSolverControlDisabledReasons(
  ctx: CommandBlockReasonContext & {
    canRunCommand: boolean;
    canPauseCommand: boolean;
    canStopCommand: boolean;
    canSkipCommand: boolean;
  },
  builderRunBlocked: boolean,
) {
  return {
    run: ctx.canRunCommand && !builderRunBlocked
      ? null
      : commandBlockedReason(ctx, "run", builderRunBlocked),
    pause: ctx.canPauseCommand
      ? null
      : commandBlockedReason(ctx, "pause", builderRunBlocked),
    stop: ctx.canStopCommand
      ? null
      : commandBlockedReason(ctx, "stop", builderRunBlocked),
    skip: ctx.canSkipCommand
      ? null
      : commandBlockedReason(ctx, "skip", builderRunBlocked),
  };
}

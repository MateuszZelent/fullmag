export interface CommandBlockReasonContext {
  interactiveEnabled: boolean;
  runtimeCanAcceptCommands: boolean;
  commandBusy: boolean;
  commandMessage: string | null;
  workspaceStatus: string;
}

export type SolverControlAction = "run" | "pause" | "stop" | "skip";

const RUNNING_SOLVER_STATUSES = new Set(["running"]);
const PAUSED_SOLVER_STATUSES = new Set(["paused"]);

function formatWorkspaceStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function normalizeWorkspaceStatus(status: string | null | undefined): string {
  return (status ?? "").trim().toLowerCase();
}

export function solverControlStatusAllows(
  action: SolverControlAction,
  workspaceStatus: string | null | undefined,
  isWaitingForCompute = false,
): boolean {
  const status = normalizeWorkspaceStatus(workspaceStatus);
  if (action === "run") {
    return (
      isWaitingForCompute ||
      status === "waiting_for_compute" ||
      status === "awaiting_command" ||
      status === "paused"
    );
  }
  if (action === "pause") {
    return RUNNING_SOLVER_STATUSES.has(status);
  }
  if (action === "stop") {
    return (
      isWaitingForCompute ||
      status === "waiting_for_compute" ||
      RUNNING_SOLVER_STATUSES.has(status) ||
      PAUSED_SOLVER_STATUSES.has(status)
    );
  }
  return RUNNING_SOLVER_STATUSES.has(status) || PAUSED_SOLVER_STATUSES.has(status);
}

export function solverControlRequiresRuntimeAcceptance(
  action: SolverControlAction,
  workspaceStatus: string | null | undefined,
  isWaitingForCompute = false,
): boolean {
  if (action === "run") {
    return normalizeWorkspaceStatus(workspaceStatus) !== "paused";
  }
  const statusAllowsInterrupt = solverControlStatusAllows(action, workspaceStatus, isWaitingForCompute);
  return !statusAllowsInterrupt;
}

export function canIssueSolverControlCommand(
  ctx: {
    interactiveEnabled: boolean;
    runtimeCanAcceptCommands: boolean;
    commandBusy: boolean;
    workspaceStatus: string | null | undefined;
    action: SolverControlAction;
    isWaitingForCompute?: boolean;
    awaitingCommand?: boolean;
    builderRunBlocked?: boolean;
  },
): boolean {
  if (!ctx.interactiveEnabled || ctx.commandBusy) {
    return false;
  }
  const statusAllowsAction =
    ctx.action === "run"
      ? Boolean(
          ctx.awaitingCommand ||
            ctx.isWaitingForCompute ||
            normalizeWorkspaceStatus(ctx.workspaceStatus) === "paused",
        )
      : solverControlStatusAllows(ctx.action, ctx.workspaceStatus, ctx.isWaitingForCompute);
  if (!statusAllowsAction) {
    return false;
  }
  if (ctx.action === "run" && ctx.builderRunBlocked) {
    return false;
  }
  return (
    ctx.runtimeCanAcceptCommands ||
    !solverControlRequiresRuntimeAcceptance(ctx.action, ctx.workspaceStatus, ctx.isWaitingForCompute)
  );
}

export function commandBlockedReason(
  ctx: CommandBlockReasonContext,
  action: SolverControlAction,
  builderRunBlocked: boolean,
): string | null {
  if (!ctx.interactiveEnabled) {
    return "Solver commands are disabled because this workspace is not running in interactive mode.";
  }
  if (
    !ctx.runtimeCanAcceptCommands &&
    solverControlRequiresRuntimeAcceptance(action, ctx.workspaceStatus)
  ) {
    return "Solver runtime is busy and cannot accept commands yet.";
  }
  if (ctx.commandBusy) {
    return ctx.commandMessage ?? "A solver command is already being sent.";
  }
  if (action === "run" && builderRunBlocked) {
    return "Compute is blocked because the Geometry builder has changes that must be built or validated first.";
  }
  if (
    solverControlStatusAllows(action, ctx.workspaceStatus) &&
    (ctx.runtimeCanAcceptCommands ||
      !solverControlRequiresRuntimeAcceptance(action, ctx.workspaceStatus))
  ) {
    return null;
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

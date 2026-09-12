"use client";

import { useMemo } from "react";
import AppBar from "@/components/shell/AppBar";
import { useCommand } from "./context-hooks";
import { resolveSolverControlDisabledReasons } from "./commandControlGuards";
import { useBuilderRunBlocked } from "./useBuilderRunBlocked";

interface ControlRoomAppBarProps {
  problemName: string;
}

export default function ControlRoomAppBar({ problemName }: ControlRoomAppBarProps) {
  const command = useCommand();
  const builderRunBlocked = useBuilderRunBlocked();
  const solverControlDisabledReasons = useMemo(
    () =>
      resolveSolverControlDisabledReasons(
        {
          interactiveEnabled: command.interactiveEnabled,
          runtimeCanAcceptCommands: command.runtimeCanAcceptCommands,
          commandBusy: command.commandBusy,
          commandMessage: command.commandMessage,
          workspaceStatus: command.workspaceStatus,
          canRunCommand: command.canRunCommand,
          canPauseCommand: command.canPauseCommand,
          canStopCommand: command.canStopCommand,
          canSkipCommand: command.canSkipCommand,
        },
        builderRunBlocked,
      ),
    [
      builderRunBlocked,
      command.canPauseCommand,
      command.canRunCommand,
      command.canSkipCommand,
      command.canStopCommand,
      command.commandBusy,
      command.commandMessage,
      command.interactiveEnabled,
      command.runtimeCanAcceptCommands,
      command.workspaceStatus,
    ],
  );

  return (
    <AppBar
      problemName={problemName}
      backend={command.session?.requested_backend ?? ""}
      runtimeEngine={command.runtimeEngineLabel ?? undefined}
      runtimeGpuLabel={command.runtimeEngineGpuLabel ?? undefined}
      status={command.workspaceStatus}
      connection={command.connection}
      commandBusy={command.commandBusy}
      commandMessage={command.commandMessage}
      canSyncScriptBuilder={Boolean(command.sessionFooter.scriptPath)}
      scriptSyncBusy={command.scriptSyncBusy}
      onSyncScriptBuilder={() => void command.syncScriptBuilder()}
      runtimeStatus={command.workspaceStatus as "idle" | "running" | "paused" | "failed" | "awaiting_command"}
      canRun={command.canRunCommand && !builderRunBlocked}
      canPause={command.canPauseCommand}
      canStop={command.canStopCommand}
      canSkip={command.canSkipCommand}
      runDisabledReason={solverControlDisabledReasons.run}
      pauseDisabledReason={solverControlDisabledReasons.pause}
      stopDisabledReason={solverControlDisabledReasons.stop}
      skipDisabledReason={solverControlDisabledReasons.skip}
      onRun={() => command.handleSimulationAction(command.primaryRunAction)}
      onPause={() => command.handleSimulationAction("pause")}
      onStop={() => command.handleSimulationAction("stop")}
      onSkip={() => command.handleSimulationAction("skip")}
    />
  );
}

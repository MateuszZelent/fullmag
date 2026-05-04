"use client";

import { useMemo } from "react";
import RibbonBar, { type RibbonBarProps } from "@/components/shell/RibbonBar";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import { useCommand, useModel, useViewport } from "./context-hooks";
import { resolveSolverControlDisabledReasons } from "./commandControlGuards";
import { useBuilderRunBlocked } from "./useBuilderRunBlocked";

type ControlRoomOwnedRibbonProps =
  | "workspaceMode"
  | "viewMode"
  | "femDiscretization"
  | "domainCapabilities"
  | "solverRunning"
  | "sidebarVisible"
  | "selectedNodeId"
  | "canRun"
  | "canRelax"
  | "canPause"
  | "canStop"
  | "canSkip"
  | "runDisabledReason"
  | "pauseDisabledReason"
  | "stopDisabledReason"
  | "skipDisabledReason"
  | "runAction"
  | "runLabel"
  | "onViewChange"
  | "onSidebarToggle"
  | "onSimAction"
  | "quickPreviewTargets"
  | "selectedQuantity"
  | "requestedPreviewComponent"
  | "requestedPreviewEveryN"
  | "requestedPreviewMaxPoints"
  | "requestedPreviewAutoScale"
  | "requestedPreviewQuantityDataStatus"
  | "magneticTextureDensity"
  | "onQuickPreviewSelect"
  | "onSetFemVectorGlyphBudget"
  | "onCapture"
  | "onExport"
  | "onStateExport"
  | "meshGenerating"
  | "meshConfigDirty"
  | "selectedObjectId"
  | "objectViewMode"
  | "sceneObjectCount"
  | "onRequestObjectFocus"
  | "onSetObjectViewMode"
  | "canSyncScriptBuilder"
  | "scriptSyncBusy"
  | "onSyncScriptBuilder"
  | "activeTransformScope";

export type ControlRoomRibbonBarProps = Omit<RibbonBarProps, ControlRoomOwnedRibbonProps>;

export default function ControlRoomRibbonBar(props: ControlRoomRibbonBarProps) {
  const viewport = useViewport();
  const command = useCommand();
  const model = useModel();
  const builderRunBlocked = useBuilderRunBlocked();
  const femDiscretization = resolveFemDiscretization(
    command.domainCapabilities,
    command.isFemBackend,
  );
  const solverControlDisabledReasons = useMemo(() => {
    return resolveSolverControlDisabledReasons(
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
    );
  }, [
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
  ]);

  return (
    <RibbonBar
      workspaceMode={viewport.workspaceStage}
      viewMode={viewport.effectiveViewMode}
      femDiscretization={femDiscretization}
      domainCapabilities={command.domainCapabilities}
      solverRunning={command.workspaceStatus === "running"}
      sidebarVisible={!viewport.sidebarCollapsed}
      selectedNodeId={model.selectedSidebarNodeId}
      canRun={command.canRunCommand && !builderRunBlocked}
      canRelax={command.canRelaxCommand && !builderRunBlocked}
      canPause={command.canPauseCommand}
      canStop={command.canStopCommand}
      canSkip={command.canSkipCommand}
      runDisabledReason={solverControlDisabledReasons.run}
      pauseDisabledReason={solverControlDisabledReasons.pause}
      stopDisabledReason={solverControlDisabledReasons.stop}
      skipDisabledReason={solverControlDisabledReasons.skip}
      runAction={command.primaryRunAction}
      runLabel={command.primaryRunLabel}
      onViewChange={viewport.handleViewModeChange}
      onSidebarToggle={() => viewport.setSidebarCollapsed((value) => !value)}
      onSimAction={command.handleSimulationAction}
      quickPreviewTargets={viewport.quickPreviewTargets}
      selectedQuantity={viewport.requestedPreviewQuantity}
      requestedPreviewComponent={viewport.requestedPreviewComponent}
      requestedPreviewEveryN={viewport.requestedPreviewEveryN}
      requestedPreviewMaxPoints={viewport.requestedPreviewMaxPoints}
      requestedPreviewAutoScale={viewport.requestedPreviewAutoScale}
      requestedPreviewQuantityDataStatus={viewport.requestedPreviewQuantityDataStatus}
      magneticTextureDensity={model.femTextureDownsampleCells}
      onQuickPreviewSelect={viewport.requestPreviewQuantity}
      onSetFemVectorGlyphBudget={(glyphBudget) =>
        void viewport.patchDisplay({
          sampling: {
            max_glyphs: glyphBudget,
          },
        })
      }
      onCapture={viewport.handleCapture}
      onExport={viewport.handleExport}
      onStateExport={() => void command.handleStateExport("compact")}
      meshGenerating={model.meshGenerating}
      meshConfigDirty={model.meshConfigDirty}
      selectedObjectId={model.selectedObjectId}
      objectViewMode={model.objectViewMode}
      sceneObjectCount={model.sceneDocument?.objects.length ?? 0}
      onRequestObjectFocus={model.requestFocusObject}
      onSetObjectViewMode={model.setObjectViewMode}
      canSyncScriptBuilder={Boolean(command.sessionFooter.scriptPath)}
      scriptSyncBusy={command.scriptSyncBusy}
      onSyncScriptBuilder={() => void command.syncScriptBuilder()}
      activeTransformScope={model.activeTransformScope}
      {...props}
    />
  );
}

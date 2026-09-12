"use client";

import { useMemo } from "react";
import RibbonBar, { type RibbonBarProps } from "@/components/shell/RibbonBar";
import { useMagneticTextureDensity } from "@/features/visualization/hooks/useVizSlice";
import { useSelectedObjectId, useSelectedSidebarNodeId, useSelectionActions } from "@/features/selection";
import {
  selectLastBuiltMeshConfigSignature,
  selectMeshGenerating,
  useMeshConfigStore,
} from "@/features/mesh-config/store/useMeshConfigStore";
import {
  selectRemoteSceneDocument,
  selectSceneDocumentDraft,
  selectSceneObjects,
  useDocumentStore,
} from "@/features/document/store/useDocumentStore";
import { useViewportStore } from "@/features/viewport-core/state/useViewportStore";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import { useCommand, useViewport } from "./context-hooks";
import { resolveSolverControlDisabledReasons } from "./commandControlGuards";
import { useBuilderRunBlocked } from "./useBuilderRunBlocked";
import { buildMeshConfigurationSignature } from "./meshWorkspace";

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
  | "onRequestViewportCameraFit"
  | "onSetObjectViewMode"
  | "canSyncScriptBuilder"
  | "scriptSyncBusy"
  | "onSyncScriptBuilder"
  | "activeTransformScope";

export type ControlRoomRibbonBarProps = Omit<RibbonBarProps, ControlRoomOwnedRibbonProps>;

export default function ControlRoomRibbonBar(props: ControlRoomRibbonBarProps) {
  const viewport = useViewport();
  const command = useCommand();
  const selectedSidebarNodeId = useSelectedSidebarNodeId();
  const selectedObjectId = useSelectedObjectId();
  const { requestFocusObject } = useSelectionActions();
  const meshGenerating = useMeshConfigStore(selectMeshGenerating);
  const lastBuiltMeshConfigSignature = useMeshConfigStore(selectLastBuiltMeshConfigSignature);
  const sceneDocumentDraft = useDocumentStore(selectSceneDocumentDraft);
  const remoteSceneDocument = useDocumentStore(selectRemoteSceneDocument);
  const sceneDocument = sceneDocumentDraft ?? remoteSceneDocument;
  const meshConfigSignature = useMemo(
    () => buildMeshConfigurationSignature(sceneDocument),
    [sceneDocument],
  );
  const meshConfigDirty = meshConfigSignature !== lastBuiltMeshConfigSignature;
  const sceneObjectCount = useDocumentStore(selectSceneObjects).length;
  const objectViewMode = useViewportStore((s) => s.objectViewMode);
  const setObjectViewMode = useViewportStore((s) => s.setObjectViewMode);
  const activeTransformScope = useViewportStore((s) => s.activeTransformScope);
  const setCameraFitRequestSeed = useViewportStore((s) => s.setCameraFitRequestSeed);
  const magneticTextureDensity = useMagneticTextureDensity();
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
      explorerVisible={props.explorerVisible}
      inspectorVisible={props.inspectorVisible}
      telemetryVisible={props.telemetryVisible}
      selectedNodeId={selectedSidebarNodeId}
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
      onRestoreWorkspacePanel={props.onRestoreWorkspacePanel}
      onHideWorkspacePanel={props.onHideWorkspacePanel}
      onSimAction={command.handleSimulationAction}
      quickPreviewTargets={viewport.quickPreviewTargets}
      selectedQuantity={viewport.requestedPreviewQuantity}
      requestedPreviewComponent={viewport.requestedPreviewComponent}
      requestedPreviewEveryN={viewport.requestedPreviewEveryN}
      requestedPreviewMaxPoints={viewport.requestedPreviewMaxPoints}
      requestedPreviewAutoScale={viewport.requestedPreviewAutoScale}
      requestedPreviewQuantityDataStatus={viewport.requestedPreviewQuantityDataStatus}
      magneticTextureDensity={magneticTextureDensity}
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
      meshGenerating={meshGenerating}
      meshConfigDirty={meshConfigDirty}
      selectedObjectId={selectedObjectId}
      objectViewMode={objectViewMode}
      sceneObjectCount={sceneObjectCount}
      onRequestObjectFocus={requestFocusObject}
      onRequestViewportCameraFit={() => {
        viewport.handleViewModeChange("3D");
        setCameraFitRequestSeed((seed) => seed + 1);
      }}
      onSetObjectViewMode={setObjectViewMode}
      canSyncScriptBuilder={Boolean(command.sessionFooter.scriptPath)}
      scriptSyncBusy={command.scriptSyncBusy}
      onSyncScriptBuilder={() => void command.syncScriptBuilder()}
      activeTransformScope={activeTransformScope}
      {...props}
    />
  );
}

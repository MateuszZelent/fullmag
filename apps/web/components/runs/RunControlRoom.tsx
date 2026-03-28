"use client";

import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import EngineConsole from "../panels/EngineConsole";
import TitleBar from "../shell/TitleBar";
import MenuBar from "../shell/MenuBar";
import RibbonBar from "../shell/RibbonBar";
import StatusBar from "../shell/StatusBar";
import ColorLegend from "../preview/ColorLegend";
import FemWorkspacePanel from "./control-room/FemWorkspacePanel";
import RunSidebar from "./control-room/RunSidebar";
import { ViewportBar, ViewportCanvasArea } from "./control-room/ViewportPanels";
import type { ViewportBarProps, ViewportCanvasAreaProps } from "./control-room/ViewportPanels";
import {
  ControlRoomProvider,
  useControlRoom,
} from "./control-room/ControlRoomContext";
import {
  PANEL_SIZES,
  fmtDuration,
  fmtSIOrDash,
  fmtStepValue,
} from "./control-room/shared";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { cn } from "@/lib/utils";
import s from "./RunControlRoom.module.css";

/* ── Inner shell (consumes context) ── */

function ControlRoomShell() {
  const ctx = useControlRoom();
  useKeyboardShortcuts();

  /* ── Loading state ── */
  if (!ctx.session) {
    return (
      <div className={s.loadingShell}>
        {ctx.error
          ? `Connection error: ${ctx.error}`
          : "Connecting to local live workspace…"}
      </div>
    );
  }

  /* ── Build prop bags for existing child components ── */
  const viewportBarProps: ViewportBarProps = {
    isMeshWorkspaceView: ctx.isMeshWorkspaceView,
    meshName: ctx.meshName,
    effectiveFemMesh: ctx.effectiveFemMesh,
    meshRenderMode: ctx.meshRenderMode,
    meshSelection: ctx.meshSelection,
    previewControlsActive: ctx.previewControlsActive,
    requestedPreviewQuantity: ctx.requestedPreviewQuantity,
    requestedPreviewComponent: ctx.requestedPreviewComponent,
    requestedPreviewEveryN: ctx.requestedPreviewEveryN,
    requestedPreviewMaxPoints: ctx.requestedPreviewMaxPoints,
    requestedPreviewXChosenSize: ctx.requestedPreviewXChosenSize,
    requestedPreviewYChosenSize: ctx.requestedPreviewYChosenSize,
    requestedPreviewAutoScale: ctx.requestedPreviewAutoScale,
    requestedPreviewLayer: ctx.requestedPreviewLayer,
    requestedPreviewAllLayers: ctx.requestedPreviewAllLayers,
    previewBusy: ctx.previewBusy,
    previewQuantityOptions: ctx.previewQuantityOptions,
    quantityOptions: ctx.quantityOptions,
    previewEveryNOptions: ctx.previewEveryNOptions,
    previewMaxPointOptions: ctx.previewMaxPointOptions,
    preview: ctx.preview,
    effectiveViewMode: ctx.effectiveViewMode,
    solverGrid: ctx.solverGrid,
    plane: ctx.plane,
    sliceIndex: ctx.sliceIndex,
    maxSliceCount: ctx.maxSliceCount,
    component: ctx.component,
    updatePreview: ctx.updatePreview,
    setSelectedQuantity: ctx.setSelectedQuantity,
    setComponent: ctx.setComponent,
    setPlane: ctx.setPlane,
    setSliceIndex: ctx.setSliceIndex,
    isFemBackend: ctx.isFemBackend,
    totalCells: ctx.totalCells,
    activeCells: ctx.activeCells,
    activeMaskPresent: ctx.activeMaskPresent,
  };

  const viewportCanvasProps: ViewportCanvasAreaProps = {
    effectiveStep: ctx.effectiveStep,
    effectiveTime: ctx.effectiveTime,
    effectiveDmDt: ctx.effectiveDmDt,
    isVectorQuantity: ctx.isVectorQuantity,
    quantityDescriptor: ctx.quantityDescriptor,
    selectedScalarValue: ctx.selectedScalarValue,
    preview: ctx.preview,
    effectiveViewMode: ctx.effectiveViewMode,
    isFemBackend: ctx.isFemBackend,
    femMeshData: ctx.femMeshData,
    femTopologyKey: ctx.femTopologyKey,
    femColorField: ctx.femColorField,
    femMagnetization3DActive: ctx.femMagnetization3DActive,
    femShouldShowArrows: ctx.femShouldShowArrows,
    meshRenderMode: ctx.meshRenderMode,
    meshOpacity: ctx.meshOpacity,
    meshClipEnabled: ctx.meshClipEnabled,
    meshClipAxis: ctx.meshClipAxis,
    meshClipPos: ctx.meshClipPos,
    selectedQuantity: ctx.selectedQuantity,
    effectiveVectorComponent: ctx.effectiveVectorComponent,
    plane: ctx.plane,
    sliceIndex: ctx.sliceIndex,
    maxSliceCount: ctx.maxSliceCount,
    selectedVectors: ctx.selectedVectors,
    previewGrid: ctx.previewGrid,
    component: ctx.component,
    emptyStateMessage: ctx.emptyStateMessage,
    activeMask: ctx.activeMask,
    setMeshRenderMode: ctx.setMeshRenderMode,
    setMeshOpacity: ctx.setMeshOpacity,
    setMeshClipEnabled: ctx.setMeshClipEnabled,
    setMeshClipAxis: ctx.setMeshClipAxis,
    setMeshClipPos: ctx.setMeshClipPos,
    setMeshShowArrows: ctx.setMeshShowArrows,
    setMeshSelection: ctx.setMeshSelection,
    worldExtent: ctx.worldExtent,
    gridCells: ctx.solverGrid[0] > 0 ? ctx.solverGrid : null,
  };

  const previewNotices = (
    <>
      {(ctx.preview?.auto_downscaled || ctx.liveState?.preview_auto_downscaled) && (
        <div
          className={s.previewNotice}
          title={ctx.preview?.auto_downscale_message ?? ctx.liveState?.preview_auto_downscale_message ?? undefined}
        >
          {ctx.preview?.auto_downscale_message ??
            ctx.liveState?.preview_auto_downscale_message ??
            `Preview auto-fit to ${ctx.previewGrid[0]}×${ctx.previewGrid[1]}×${ctx.previewGrid[2]}`}
        </div>
      )}
      {(ctx.previewMessage || ctx.previewIsStale || ctx.previewIsBootstrapStale) && (
        <div className={s.previewStatus}>
          {ctx.previewMessage ??
            (ctx.previewIsBootstrapStale
              ? "Showing bootstrap preview until first live preview sample arrives"
              : "Preview update pending")}
        </div>
      )}
    </>
  );

  const femWorkspaceProps = {
    workspaceStatus: ctx.workspaceStatus,
    femDockTab: ctx.femDockTab,
    setFemDockTab: ctx.setFemDockTab,
    openFemMeshWorkspace: ctx.openFemMeshWorkspace,
    effectiveFemMesh: ctx.effectiveFemMesh,
    meshFeOrder: ctx.meshFeOrder,
    meshHmax: ctx.meshHmax,
    isMeshWorkspaceView: ctx.isMeshWorkspaceView,
    effectiveViewMode: ctx.effectiveViewMode,
    handleViewModeChange: ctx.handleViewModeChange,
    meshRenderMode: ctx.meshRenderMode,
    setMeshRenderMode: ctx.setMeshRenderMode,
    meshFaceDetail: ctx.meshFaceDetail,
    meshSelection: ctx.meshSelection,
    setMeshSelection: ctx.setMeshSelection,
    meshName: ctx.meshName,
    meshSource: ctx.meshSource,
    meshExtent: ctx.meshExtent,
    meshBoundsMin: ctx.meshBoundsMin,
    meshBoundsMax: ctx.meshBoundsMax,
    mesherBackend: ctx.mesherBackend,
    mesherSourceKind: ctx.mesherSourceKind,
    mesherCurrentSettings: ctx.mesherCurrentSettings,
    meshOptions: ctx.meshOptions,
    setMeshOptions: ctx.setMeshOptions,
    meshQualityData: ctx.meshQualityData,
    meshGenerating: ctx.meshGenerating,
    handleMeshGenerate: ctx.handleMeshGenerate,
    previewControlsActive: ctx.previewControlsActive,
    requestedPreviewQuantity: ctx.requestedPreviewQuantity,
    previewQuantityOptions: ctx.previewQuantityOptions,
    previewBusy: ctx.previewBusy,
    updatePreview: ctx.updatePreview,
    setSelectedQuantity: ctx.setSelectedQuantity,
    requestedPreviewComponent: ctx.requestedPreviewComponent,
    component: ctx.component,
    setComponent: ctx.setComponent,
    requestedPreviewEveryN: ctx.requestedPreviewEveryN,
    previewEveryNOptions: ctx.previewEveryNOptions,
    meshOpacity: ctx.meshOpacity,
    setMeshOpacity: ctx.setMeshOpacity,
    meshShowArrows: ctx.meshShowArrows,
    setMeshShowArrows: ctx.setMeshShowArrows,
    meshClipEnabled: ctx.meshClipEnabled,
    setMeshClipEnabled: ctx.setMeshClipEnabled,
    meshClipAxis: ctx.meshClipAxis,
    setMeshClipAxis: ctx.setMeshClipAxis,
    meshClipPos: ctx.meshClipPos,
    setMeshClipPos: ctx.setMeshClipPos,
    meshQualitySummary: ctx.meshQualitySummary,
    viewportBarProps,
    viewportCanvasProps,
    previewNotices,
  };

  const canRun = ctx.interactiveEnabled && ctx.awaitingCommand && !ctx.commandBusy;
  const canRelax = ctx.interactiveEnabled && ctx.awaitingCommand && !ctx.commandBusy;
  const canPause = ctx.interactiveEnabled && ctx.workspaceStatus === "running" && !ctx.commandBusy;
  const canStop = ctx.interactiveEnabled && ctx.workspaceStatus === "running" && !ctx.commandBusy;




  return (
    <div className={s.shell}>
      <TitleBar
        problemName={ctx.session?.problem_name ?? "Local Live Workspace"}
        backend={ctx.session?.requested_backend ?? ""}
        runtimeEngine={ctx.runtimeEngineLabel ?? undefined}
        status={ctx.workspaceStatus}
        connection={ctx.connection}
        interactiveEnabled={ctx.interactiveEnabled}
        runEnabled={canRun}
        relaxEnabled={canRelax}
        pauseEnabled={canPause}
        stopEnabled={canStop}
        commandMessage={ctx.commandMessage}
        onSimAction={ctx.handleSimulationAction}
      />
      <MenuBar
        viewMode={ctx.effectiveViewMode}
        interactiveEnabled={ctx.interactiveEnabled}
        canRun={canRun}
        canRelax={canRelax}
        canPause={canPause}
        canStop={canStop}
        onViewChange={ctx.handleViewModeChange}
        onSidebarToggle={() => ctx.setSidebarCollapsed((v) => !v)}
        onSimAction={ctx.handleSimulationAction}
      />
      <RibbonBar
        viewMode={ctx.effectiveViewMode}
        isFemBackend={ctx.isFemBackend}
        solverRunning={ctx.workspaceStatus === "running"}
        sidebarVisible={!ctx.sidebarCollapsed}
        selectedNodeId={ctx.selectedSidebarNodeId}
        canRun={canRun}
        canRelax={canRelax}
        canPause={canPause}
        canStop={canStop}
        onViewChange={ctx.handleViewModeChange}
        onSidebarToggle={() => ctx.setSidebarCollapsed((v) => !v)}
        onSimAction={ctx.handleSimulationAction}
        onSetup={() => ctx.setSolverSetupOpen((v) => !v)}
        onCapture={ctx.handleCapture}
        onExport={ctx.handleExport}
      />
      <PanelGroup
        orientation="horizontal"
        className={s.body}
        resizeTargetMinimumSize={{ coarse: 40, fine: 12 }}
      >
        <Panel
          id="workspace-main"
          defaultSize={ctx.sidebarCollapsed ? "100%" : PANEL_SIZES.bodyMainDefault}
          minSize={PANEL_SIZES.bodyMainMin}
        >
          <PanelGroup
            orientation="vertical"
            className={s.main}
            resizeTargetMinimumSize={{ coarse: 40, fine: 10 }}
          >
            <Panel
              id="workspace-viewport"
              defaultSize={PANEL_SIZES.viewportDefault}
              minSize={PANEL_SIZES.viewportMin}
            >
              {ctx.isFemBackend ? (
                <PanelGroup
                  orientation="horizontal"
                  className={s.workspaceSplit}
                  resizeTargetMinimumSize={{ coarse: 40, fine: 12 }}
                >
                  <FemWorkspacePanel {...femWorkspaceProps} />
                </PanelGroup>
              ) : (
                <div className={cn(s.viewport, s.viewportRow)}>
                  <div className={s.viewportMainColumn}>
                    <ViewportBar {...viewportBarProps} />
                    {previewNotices}
                    <ViewportCanvasArea {...viewportCanvasProps} />
                  </div>
                  <ColorLegend />
                </div>
              )}
            </Panel>

            <PanelResizeHandle className={s.resizeHandle} />

            <Panel
              id="workspace-console"
              defaultSize={PANEL_SIZES.consoleDefault}
              minSize={PANEL_SIZES.consoleMin}
              maxSize={PANEL_SIZES.consoleMax}
              collapsible
              collapsedSize="3%"
            >
              <div className={s.console}>
                <EngineConsole
                  session={ctx.session ?? null}
                  run={ctx.run ?? null}
                  liveState={ctx.effectiveLiveState ?? null}
                  scalarRows={ctx.scalarRows}
                  engineLog={ctx.engineLog}
                  artifacts={ctx.artifacts}
                  connection={ctx.connection}
                  error={ctx.error}
                  presentationMode="current"
                />
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        {!ctx.sidebarCollapsed && (
          <>
            <PanelResizeHandle className={s.sidebarResizeHandle} />
            <Panel
              id="workspace-sidebar"
              defaultSize={PANEL_SIZES.sidebarDefault}
              minSize={PANEL_SIZES.sidebarMin}
              maxSize={PANEL_SIZES.sidebarMax}
              collapsible
              collapsedSize="0%"
            >
              <RunSidebar />
            </Panel>
          </>
        )}
      </PanelGroup>

      <StatusBar
        connection={ctx.connection}
        step={ctx.effectiveLiveState?.step ?? ctx.run?.total_steps ?? 0}
        stepDisplay={fmtStepValue(ctx.effectiveLiveState?.step ?? ctx.run?.total_steps ?? 0, ctx.hasSolverTelemetry)}
        simTime={fmtSIOrDash(ctx.effectiveLiveState?.time ?? ctx.run?.final_time ?? 0, "s", ctx.hasSolverTelemetry)}
        wallTime={ctx.elapsed > 0 ? fmtDuration(ctx.elapsed) : "—"}
        throughput={ctx.stepsPerSec > 0 ? `${ctx.stepsPerSec.toFixed(1)} st/s` : "—"}
        backend={ctx.session?.requested_backend ?? ""}
        runtimeEngine={ctx.runtimeEngineLabel ?? undefined}
        precision={ctx.session?.precision ?? ""}
        status={ctx.workspaceStatus}
        activityLabel={ctx.activity.label}
        activityDetail={ctx.activity.detail}
        progressMode={ctx.activity.progressMode}
        progressValue={ctx.activity.progressValue}
        nodeCount={ctx.isFemBackend && ctx.femMesh
          ? `${ctx.femMesh.nodes.length.toLocaleString()} nodes`
          : ctx.totalCells && ctx.totalCells > 0
            ? `${ctx.totalCells.toLocaleString()} cells`
            : undefined}
      />
    </div>
  );
}

/* ── Public export ── */

export default function RunControlRoom() {
  return (
    <ControlRoomProvider>
      <ControlRoomShell />
    </ControlRoomProvider>
  );
}

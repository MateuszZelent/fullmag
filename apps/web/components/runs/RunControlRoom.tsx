"use client";

import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import EngineConsole from "../panels/EngineConsole";
import TitleBar from "../shell/TitleBar";
import MenuBar from "../shell/MenuBar";
import RibbonBar from "../shell/RibbonBar";
import StatusBar from "../shell/StatusBar";
import ColorLegend from "../preview/ColorLegend";
import RunSidebar from "./control-room/RunSidebar";
import { ViewportBar, ViewportCanvasArea } from "./control-room/ViewportPanels";
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

/* ── Inner shell (consumes context) ── */

function ControlRoomShell() {
  const ctx = useControlRoom();
  useKeyboardShortcuts();

  /* ── Loading state ── */
  if (!ctx.session) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-sm text-muted-foreground h-full bg-background">
        {ctx.error
          ? `Connection error: ${ctx.error}`
          : "Connecting to local live workspace…"}
      </div>
    );
  }

  const previewNotices = (
    <>
      {(ctx.preview?.auto_downscaled || ctx.liveState?.preview_auto_downscaled) && (
        <div
          className="px-2.5 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-amber-500 text-xs leading-snug"
          title={ctx.preview?.auto_downscale_message ?? ctx.liveState?.preview_auto_downscale_message ?? undefined}
        >
          {ctx.preview?.auto_downscale_message ??
            ctx.liveState?.preview_auto_downscale_message ??
            `Preview auto-fit to ${ctx.previewGrid[0]}×${ctx.previewGrid[1]}×${ctx.previewGrid[2]}`}
        </div>
      )}
      {(ctx.previewMessage || ctx.previewIsStale || ctx.previewIsBootstrapStale) && (
        <div className="px-2.5 py-1.5 border-b border-border/40 bg-card/40 text-muted-foreground text-xs leading-snug">
          {ctx.previewMessage ??
            (ctx.previewIsBootstrapStale
              ? "Showing bootstrap preview until first live preview sample arrives"
              : "Preview update pending")}
        </div>
      )}
    </>
  );

  const canRun = ctx.interactiveEnabled && ctx.awaitingCommand && !ctx.commandBusy;
  const canRelax = ctx.interactiveEnabled && ctx.awaitingCommand && !ctx.commandBusy;
  const canPause = ctx.interactiveEnabled && ctx.workspaceStatus === "running" && !ctx.commandBusy;
  const canStop = ctx.interactiveEnabled && ctx.workspaceStatus === "running" && !ctx.commandBusy;




  return (
    <div className="fixed inset-0 flex flex-col bg-background font-sans text-foreground text-base overflow-hidden">
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
        className="flex flex-row flex-1 min-h-0 min-w-0 overflow-hidden"
        resizeTargetMinimumSize={{ coarse: 40, fine: 12 }}
      >
        {!ctx.sidebarCollapsed && (
          <>
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
            <PanelResizeHandle className="h-full w-2 bg-transparent cursor-ew-resize flex items-center justify-center transition-colors relative hover:bg-muted/50 active:bg-muted/50 after:content-[''] after:absolute after:top-1/2 after:left-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:w-[2px] after:h-9 after:rounded-full after:bg-border hover:after:bg-primary active:after:bg-primary z-50" />
          </>
        )}

        <Panel
          id="workspace-main"
          defaultSize={ctx.sidebarCollapsed ? "100%" : PANEL_SIZES.bodyMainDefault}
          minSize={PANEL_SIZES.bodyMainMin}
        >
          <PanelGroup
            orientation="vertical"
            className="relative flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden"
            resizeTargetMinimumSize={{ coarse: 40, fine: 10 }}
          >
            <Panel
              id="workspace-viewport"
              defaultSize={PANEL_SIZES.viewportDefault}
              minSize={PANEL_SIZES.viewportMin}
            >
                <div className="flex flex-row h-full min-h-0 min-w-0 overflow-hidden bg-black flex-1 relative shadow-[inset_0_0_60px_rgba(0,0,0,0.5)]">
                  <div className="flex flex-col flex-1 min-w-0 min-h-0">
                    <ViewportBar />
                    {previewNotices}
                    <ViewportCanvasArea />
                  </div>
                  <ColorLegend />
                </div>
            </Panel>

            <PanelResizeHandle className="w-full h-1 bg-transparent cursor-ns-resize flex items-center justify-center transition-colors relative hover:bg-muted/50 active:bg-muted/50 after:content-[''] after:absolute after:top-1/2 after:left-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:h-[2px] after:w-9 after:rounded-full after:bg-border hover:after:bg-primary active:after:bg-primary z-50" />

            <Panel
              id="workspace-console"
              defaultSize={PANEL_SIZES.consoleDefault}
              minSize={PANEL_SIZES.consoleMin}
              maxSize={PANEL_SIZES.consoleMax}
              collapsible
              collapsedSize="3%"
            >
              <div className="flex flex-col h-full bg-card/50 backdrop-blur-xl isolate overflow-hidden relative z-40 border-t border-border/60 shadow-[0_-8px_30px_rgba(0,0,0,0.3)]">
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

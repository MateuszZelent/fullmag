"use client";

import { useEffect, useMemo } from "react";
import { Pin, X } from "lucide-react";

import AnalyzeViewport from "@/components/runs/control-room/AnalyzeViewport";
import ChartsViewport from "@/components/runs/control-room/ChartsViewport";
import { ViewportBar, ViewportCanvasArea } from "@/components/runs/control-room/ViewportPanels";
import { useModel, useTransport, useViewport } from "@/components/runs/control-room/context-hooks";
import EmptyState from "@/components/ui/EmptyState";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { useRuntimeFeatureFlags } from "@/lib/hooks/useRuntimeFeatureFlags";
import { cn } from "@/lib/utils";
import { type AnalyzeTab } from "@/components/runs/control-room/analyzeSelection";
import {
  type WorkspaceMode,
  type WorkspaceTab,
  useWorkspaceStore,
} from "@/lib/workspace/workspace-store";

function isAnalyzeTab(value: string | undefined): value is AnalyzeTab {
  return (
    value === "summary" ||
    value === "spectrum" ||
    value === "modes" ||
    value === "dispersion" ||
    value === "time-traces" ||
    value === "vortex-trajectory" ||
    value === "vortex-frequency" ||
    value === "vortex-orbit"
  );
}

function asAnalyzeTab(value: string | undefined): AnalyzeTab {
  return isAnalyzeTab(value) ? value : "spectrum";
}

function isAnalyzeLikeTab(tab: WorkspaceTab): boolean {
  if (tab.kind === "analyze") return true;
  if (tab.kind === "result-quantity") return false;
  return tab.kind.startsWith("result-");
}

function analyzeSelectionForTab(tab: WorkspaceTab):
  | { domain: "eigenmodes" | "vortex"; tab: AnalyzeTab; selectedModeIndex?: number | null }
  | null {
  switch (tab.kind) {
    case "analyze":
      return {
        domain: (tab.payload?.analyzeDomain ?? "eigenmodes") as "eigenmodes" | "vortex",
        tab: asAnalyzeTab(tab.payload?.analyzeTab),
      };
    case "result-spectrum":
      return { domain: "eigenmodes", tab: "spectrum", selectedModeIndex: null };
    case "result-dispersion":
      return { domain: "eigenmodes", tab: "dispersion", selectedModeIndex: null };
    case "result-modes":
      return { domain: "eigenmodes", tab: "modes" };
    case "result-time-traces":
      return { domain: "vortex", tab: "time-traces" };
    case "result-vortex-frequency":
      return { domain: "vortex", tab: "vortex-frequency" };
    case "result-vortex-trajectory":
      return { domain: "vortex", tab: "vortex-trajectory" };
    case "result-vortex-orbit":
      return { domain: "vortex", tab: "vortex-orbit" };
    case "result-table":
      return { domain: "eigenmodes", tab: "spectrum" };
    default:
      return null;
  }
}

function sameAnalyzeSelection(
  current: { domain: "eigenmodes" | "vortex"; tab: AnalyzeTab; selectedModeIndex: number | null },
  next: { domain: "eigenmodes" | "vortex"; tab: AnalyzeTab; selectedModeIndex?: number | null },
): boolean {
  return (
    current.domain === next.domain &&
    current.tab === next.tab &&
    (current.selectedModeIndex ?? null) === (next.selectedModeIndex ?? null)
  );
}

function applyWorkspaceTabSelection(
  stage: WorkspaceMode,
  tab: WorkspaceTab,
  api: {
    currentWorkspaceMode: WorkspaceMode;
    setWorkspaceMode: (next: WorkspaceMode | ((prev: WorkspaceMode) => WorkspaceMode)) => void;
    handleViewModeChange: (mode: string) => void;
    effectiveViewMode: "3D" | "2D" | "Mesh" | "Analyze";
    requestPreviewQuantity: (quantity: string) => void;
    selectedQuantity: string;
    model: ReturnType<typeof useModel>;
  },
): void {
  if (tab.payload?.resultWorkspaceId) {
    if (
      api.currentWorkspaceMode !== "analyze" ||
      api.model.activeResultWorkspaceId !== tab.payload.resultWorkspaceId
    ) {
      api.model.openResultWorkspaceEntry(tab.payload.resultWorkspaceId);
    }
    return;
  }

  if (tab.kind === "viewport-3d") {
    api.setWorkspaceMode(stage);
    if (api.effectiveViewMode !== "3D") {
      api.handleViewModeChange("3D");
    }
    return;
  }
  if (tab.kind === "viewport-2d") {
    api.setWorkspaceMode(stage);
    if (api.effectiveViewMode !== "2D") {
      api.handleViewModeChange("2D");
    }
    return;
  }
  if (tab.kind === "viewport-mesh") {
    api.setWorkspaceMode(stage);
    if (api.effectiveViewMode !== "Mesh") {
      api.handleViewModeChange("Mesh");
    }
    return;
  }
  if (tab.kind === "viewport-charts") {
    api.setWorkspaceMode(stage);
    return;
  }
  if (tab.kind === "result-quantity") {
    api.setWorkspaceMode(stage);
    if (tab.payload?.quantityId && tab.payload.quantityId !== api.selectedQuantity) {
      api.requestPreviewQuantity(tab.payload.quantityId);
    }
    if (api.effectiveViewMode !== "3D") {
      api.handleViewModeChange("3D");
    }
    return;
  }

  const analyzeSelection = analyzeSelectionForTab(tab);
  if (analyzeSelection) {
    if (api.currentWorkspaceMode !== "analyze") {
      api.setWorkspaceMode("analyze");
    }
    if (!sameAnalyzeSelection(api.model.analyzeSelection, analyzeSelection)) {
      api.model.openAnalyze({
        domain: analyzeSelection.domain,
        tab: analyzeSelection.tab,
        selectedModeIndex: analyzeSelection.selectedModeIndex ?? null,
      });
    }
    return;
  }

  api.setWorkspaceMode(stage);
}

export default function DockCenterTabs() {
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const tabs = useWorkspaceStore((state) => state.workspaceTabsByStage[state.currentStage]);
  const activeTabId = useWorkspaceStore(
    (state) => state.activeWorkspaceTabByStage[state.currentStage],
  );
  const activateTab = useWorkspaceStore((state) => state.activateTab);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const pinTab = useWorkspaceStore((state) => state.pinTab);
  const openTab = useWorkspaceStore((state) => state.openTab);

  const vp = useViewport();
  const model = useModel();
  const tp = useTransport();
  const featureFlags = useRuntimeFeatureFlags();
  const currentWorkspaceMode = vp.workspaceMode;
  const effectiveViewMode = vp.effectiveViewMode;
  const selectedQuantity = vp.selectedQuantity;

  // Block rendering until feature flags are resolved to avoid mounting Three.js
  // canvases that would be immediately disabled (causes WebGL context churn).
  const flagsLoading = featureFlags === null;
  const chartsDisabled = featureFlags?.disable_charts ?? false;
  const preview3dDisabled = featureFlags?.disable_preview_3d ?? false;

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [activeTabId, tabs],
  );

  useEffect(() => {
    if (!activeTabId && tabs.length > 0) {
      activateTab(currentStage, tabs[0]!.id);
    }
  }, [activateTab, activeTabId, currentStage, tabs]);

  useEffect(() => {
    if (tabs.some((tab) => tab.id === "core:charts")) {
      return;
    }
    openTab(currentStage, {
      id: "core:charts",
      key: "core:charts",
      kind: "viewport-charts",
      title: "Charts",
      closable: false,
      pinned: true,
      keepAlive: true,
      lifecycle: "warm",
      payload: { viewMode: "Analyze" },
    });
  }, [currentStage, openTab, tabs]);

  useEffect(() => {
    if (!activeTab) {
      return;
    }
    applyWorkspaceTabSelection(currentStage, activeTab, {
      currentWorkspaceMode,
      setWorkspaceMode: vp.setWorkspaceMode,
      handleViewModeChange: vp.handleViewModeChange,
      effectiveViewMode,
      requestPreviewQuantity: vp.requestPreviewQuantity,
      selectedQuantity,
      model,
    });
  }, [activeTab, currentStage, currentWorkspaceMode, effectiveViewMode, selectedQuantity, model, vp.handleViewModeChange, vp.requestPreviewQuantity, vp.setWorkspaceMode]);

  const spatialPreview = tp.preview?.kind === "spatial" ? tp.preview : null;
  const previewNoticesVisible = FRONTEND_DIAGNOSTIC_FLAGS.shell.showPreviewNotices;

  if (flagsLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        Loading…
      </div>
    );
  }

  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyState
          title="No workspace tabs"
          description="Open 3D/2D/Mesh/Analyze/Charts tabs from the ribbon or results tree."
          tone="info"
          compact
        />
      </div>
    );
  }

  const activeTabIsCharts = activeTab?.kind === "viewport-charts";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar && !activeTabIsCharts ? <ViewportBar /> : null}

      {previewNoticesVisible && (
        <>
          {(spatialPreview?.auto_downscaled || tp.liveState?.preview_auto_downscaled) && (
            <div
              className="border-b border-border/25 bg-background/40 px-2.5 py-1 text-[0.65rem] leading-tight text-muted-foreground"
              title={
                spatialPreview?.auto_downscale_message ??
                tp.liveState?.preview_auto_downscale_message ??
                undefined
              }
            >
              <span className="opacity-70 uppercase tracking-wider font-semibold mr-2 text-[0.6rem]">Resolution Scale</span>
              {spatialPreview?.auto_downscale_message ??
                tp.liveState?.preview_auto_downscale_message ??
                `Preview auto-fit to ${vp.previewGrid[0]}×${vp.previewGrid[1]}×${vp.previewGrid[2]}`}
            </div>
          )}
          {(vp.previewMessage || vp.previewIsStale || vp.previewIsInitialSampleStale) && (
            <div className="border-b border-border/40 bg-card/40 px-2.5 py-1.5 text-xs leading-snug text-muted-foreground">
              {vp.previewMessage ??
                (vp.previewIsInitialSampleStale
                  ? "Showing bootstrap preview until first live preview sample arrives 3"
                  : "Preview update pending")}
            </div>
          )}
        </>
      )}

      <TooltipProvider delayDuration={300}>
        <Tabs
          value={activeTab?.id}
          onValueChange={(nextId) => activateTab(currentStage, nextId)}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
        <div className="shrink-0 border-b border-border bg-card/40 px-2 pt-1.5">
          <TabsList className="h-8 w-full justify-start gap-1 overflow-x-auto bg-transparent p-0 pb-0">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className={cn(
                  "group relative h-8 min-w-[120px] max-w-[220px] justify-start gap-1 rounded-none rounded-t-md border-b-0 border border-transparent bg-transparent px-2.5 py-0 text-[0.7rem] normal-case tracking-wide text-muted-foreground transition-colors hover:text-foreground",
                  "data-[state=active]:border-border data-[state=active]:border-t-2 data-[state=active]:border-t-primary data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none",
                  "after:absolute after:-bottom-[1px] after:left-0 after:right-0 after:h-[1px] data-[state=active]:after:bg-background"
                )}
                title={tab.title}
              >
                <span className="truncate">{tab.title}</span>
                {tab.pinned ? <Pin className="size-3 opacity-65" /> : null}
                {tab.closable && !tab.pinned ? (
                  <div
                    role="button"
                    tabIndex={-1}
                    className="ml-auto inline-flex size-4 items-center justify-center rounded-sm p-0 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      closeTab(currentStage, tab.id);
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        closeTab(currentStage, tab.id);
                      }
                    }}
                    title="Close tab"
                    aria-label={`Close ${tab.title}`}
                  >
                    <X className="size-3" />
                  </div>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {tabs.map((tab) => {
          const isActive = tab.id === activeTab?.id;
          const shouldKeepWarm = tab.lifecycle === "warm";
          const shouldRender = isActive || shouldKeepWarm;
          if (!shouldRender) {
            return null;
          }
          return (
            <TabsContent
              key={tab.id}
              value={tab.id}
              forceMount={shouldKeepWarm ? true : undefined}
              className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {tab.kind === "viewport-charts" ? (
                chartsDisabled ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
                    Charts disabled via feature flags
                  </div>
                ) : (
                  <ChartsViewport />
                )
              ) : isAnalyzeLikeTab(tab) ? (
                <AnalyzeViewport />
              ) : preview3dDisabled ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
                  3D preview disabled via feature flags
                </div>
              ) : (
                <ViewportCanvasArea />
              )}

              {tab.closable && (
                <div className="pointer-events-none absolute bottom-2 right-2 z-20 hidden md:block">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="pointer-events-auto h-7 text-[0.66rem]"
                    onClick={() => pinTab(currentStage, tab.id, !tab.pinned)}
                  >
                    {tab.pinned ? "Unpin" : "Pin"}
                  </Button>
                </div>
              )}
            </TabsContent>
          );
        })}
        </Tabs>
      </TooltipProvider>
    </div>
  );
}

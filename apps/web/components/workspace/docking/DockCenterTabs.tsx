"use client";

import { useCallback, useEffect, useMemo, useRef, startTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

import { ViewportBar } from "@/components/runs/control-room/ViewportPanels";
import { useTransport, useViewport } from "@/components/runs/control-room/context-hooks";
import EmptyState from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  selectActiveAnalyzeResultWorkspaceId,
  selectAnalyzeResultWorkspaceEntries,
  selectAnalyzeSelection,
  useAnalyzeStore,
} from "@/features/analyze/store/useAnalyzeStore";
import type {
  AnalyzeSelectionState,
  OpenAnalyzeSurfaceOptions,
  ResultWorkspaceKind,
} from "@/features/analyze/model/analyzeTypes";
import { useSelectionStore } from "@/features/selection/store/useSelectionStore";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { useRuntimeFeatureFlags } from "@/lib/hooks/useRuntimeFeatureFlags";
import {
  disposeViewportResourceOwner,
  workspaceViewportResourceOwnerId,
} from "@/lib/workspace/viewport-resource-owner";
import { ViewportResourceOwnerProvider } from "@/lib/workspace/viewport-resource-owner-context";
import { type WorkspaceTab, useWorkspaceStore } from "@/lib/workspace/workspace-store";
import {
  workspaceHrefForTabSlug,
  workspaceRouteSlugForTab,
} from "@/lib/workspace/workspace-route";

import { DockCenterPreviewNotices } from "./center-tabs/DockCenterPreviewNotices";
import { DockCenterTabContent } from "./center-tabs/DockCenterTabContent";
import { DockCenterTabHeader } from "./center-tabs/DockCenterTabHeader";
import {
  isWebGLWorkspaceTab,
  resolveWorkspaceTabRenderDecision,
} from "./center-tabs/tabRenderPolicy";
import {
  resolveWorkspaceTabResourceDisposals,
  type WorkspaceTabResourceLifecycleSnapshot,
} from "./center-tabs/tabResourceLifecycle";
import { useDockCenterTabSelection } from "./center-tabs/useDockCenterTabSelection";

function analyzeSelectionForResultKind(
  kind: ResultWorkspaceKind,
): Partial<AnalyzeSelectionState> | null {
  if (kind === "spectrum") return { domain: "eigenmodes", tab: "spectrum", selectedModeIndex: null };
  if (kind === "dispersion") return { domain: "eigenmodes", tab: "dispersion", selectedModeIndex: null };
  if (kind === "modes") return { domain: "eigenmodes", tab: "modes" };
  if (kind === "time-traces") return { domain: "vortex", tab: "time-traces" };
  if (kind === "vortex-frequency") return { domain: "vortex", tab: "vortex-frequency" };
  if (kind === "vortex-trajectory") return { domain: "vortex", tab: "vortex-trajectory" };
  if (kind === "vortex-orbit") return { domain: "vortex", tab: "vortex-orbit" };
  if (kind === "table") return { domain: "eigenmodes", tab: "spectrum", selectedModeIndex: null };
  return null;
}

export default function DockCenterTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const dockCenterFlags = FRONTEND_DIAGNOSTIC_FLAGS.dockCenterTabs;
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
  const tp = useTransport();
  const featureFlags = useRuntimeFeatureFlags();

  const currentWorkspaceMode = vp.workspaceMode;
  const effectiveViewMode = vp.effectiveViewMode;
  const selectedQuantity = vp.selectedQuantity;
  const setWorkspaceMode = vp.setWorkspaceMode;
  const handleViewModeChange = vp.handleViewModeChange;
  const requestPreviewQuantity = vp.requestPreviewQuantity;
  const setViewMode = vp.setViewMode;
  const activeResultWorkspaceId = useAnalyzeStore(selectActiveAnalyzeResultWorkspaceId);
  const resultWorkspaceEntries = useAnalyzeStore(selectAnalyzeResultWorkspaceEntries);
  const setActiveResultWorkspaceId = useAnalyzeStore((state) => state.setActiveResultWorkspaceId);
  const analyzeSelection = useAnalyzeStore(selectAnalyzeSelection);
  const setAnalyzeSelection = useAnalyzeStore((state) => state.setSelection);
  const setSelectedSidebarNodeId = useSelectionStore((state) => state.setSelectedSidebarNodeId);
  const tabResourceLifecycleRef = useRef<WorkspaceTabResourceLifecycleSnapshot | null>(null);

  // Block rendering until feature flags are resolved to avoid mounting Three.js
  // canvases that would be immediately disabled (causes WebGL context churn).
  const flagsLoading = dockCenterFlags.enableFeatureFlagsLoadingGate && featureFlags === null;
  const chartsDisabled = featureFlags?.disable_charts ?? false;
  const preview3dDisabled = featureFlags?.disable_preview_3d ?? false;

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [activeTabId, tabs],
  );

  useEffect(() => {
    if (!dockCenterFlags.enableInternalTree || !dockCenterFlags.enableAutoActivateEffect) {
      return;
    }
    if (!activeTabId && tabs.length > 0) {
      activateTab(currentStage, tabs[0]!.id);
    }
  }, [
    activateTab,
    activeTabId,
    currentStage,
    dockCenterFlags.enableAutoActivateEffect,
    dockCenterFlags.enableInternalTree,
    tabs,
  ]);

  useEffect(() => {
    if (!dockCenterFlags.enableInternalTree || !dockCenterFlags.enableEnsureChartsTabEffect) {
      return;
    }
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
      mountPolicy: "active-only",
      payload: { viewMode: "Analyze" },
    });
  }, [
    currentStage,
    dockCenterFlags.enableEnsureChartsTabEffect,
    dockCenterFlags.enableInternalTree,
    openTab,
    tabs,
  ]);

  const openAnalyzeSurface = useCallback((options: OpenAnalyzeSurfaceOptions = {}) => {
    startTransition(() => {
      if (options.resultWorkspaceId) {
        setActiveResultWorkspaceId(options.resultWorkspaceId);
        setSelectedSidebarNodeId(`res-analysis-${options.resultWorkspaceId}`);
        const entry = resultWorkspaceEntries.find(
          (candidate) => candidate.id === options.resultWorkspaceId,
        );
        if (!entry) {
          return;
        }
        const nextSelection = analyzeSelectionForResultKind(entry.kind);
        if (nextSelection) {
          setAnalyzeSelection((prev) => ({ ...prev, ...nextSelection }));
          setViewMode("Analyze");
          return;
        }
        if (entry.quantityId) {
          requestPreviewQuantity(entry.quantityId);
          setViewMode("3D");
        }
        return;
      }

      activateTab(currentStage, "core:analyze");
      setViewMode("Analyze");
      if (options.selection) {
        setAnalyzeSelection((prev) => ({ ...prev, ...options.selection }));
      }
    });
  }, [
    activateTab,
    currentStage,
    requestPreviewQuantity,
    resultWorkspaceEntries,
    setActiveResultWorkspaceId,
    setAnalyzeSelection,
    setSelectedSidebarNodeId,
    setViewMode,
  ]);

  const selectionApi = useMemo(
    () => ({
      currentWorkspaceMode,
      setWorkspaceMode,
      handleViewModeChange,
      effectiveViewMode,
      requestPreviewQuantity,
      selectedQuantity,
      activeResultWorkspaceId,
      analyzeSelection,
      openAnalyzeSurface,
    }),
    [
      activeResultWorkspaceId,
      analyzeSelection,
      currentWorkspaceMode,
      effectiveViewMode,
      handleViewModeChange,
      openAnalyzeSurface,
      requestPreviewQuantity,
      selectedQuantity,
      setWorkspaceMode,
    ],
  );

  useDockCenterTabSelection({
    enabled: dockCenterFlags.enableInternalTree && dockCenterFlags.enableApplySelectionEffect,
    stage: currentStage,
    activeTab,
    api: selectionApi,
  });

  useEffect(() => {
    const currentSnapshot: WorkspaceTabResourceLifecycleSnapshot = {
      stage: currentStage,
      tabs,
      activeTabId,
    };
    const disposals = resolveWorkspaceTabResourceDisposals(
      tabResourceLifecycleRef.current,
      currentSnapshot,
    );
    tabResourceLifecycleRef.current = currentSnapshot;
    for (const disposal of disposals) {
      disposeViewportResourceOwner(disposal.ownerId, disposal.reason);
    }
  }, [activeTabId, currentStage, tabs]);

  const spatialPreview = tp.preview?.kind === "spatial" ? tp.preview : null;
  const previewNoticesVisible =
    FRONTEND_DIAGNOSTIC_FLAGS.shell.showPreviewNotices && dockCenterFlags.showPreviewNotices;

  const activeTabIsCharts = activeTab?.kind === "viewport-charts";

  const renderTabContent = (tab: WorkspaceTab, viewportVisible = tab.id === activeTab?.id) => {
    const content = (
      <DockCenterTabContent
        tab={tab}
        flags={dockCenterFlags}
        chartsDisabled={chartsDisabled}
        preview3dDisabled={preview3dDisabled}
        viewportVisible={viewportVisible}
      />
    );
    if (!isWebGLWorkspaceTab(tab)) {
      return content;
    }
    return (
      <ViewportResourceOwnerProvider ownerId={workspaceViewportResourceOwnerId(currentStage, tab.id)}>
        {content}
      </ViewportResourceOwnerProvider>
    );
  };

  const previewNotices = previewNoticesVisible ? (
    <DockCenterPreviewNotices
      autoDownscaled={Boolean(
        spatialPreview?.auto_downscaled || tp.liveState?.preview_auto_downscaled,
      )}
      autoDownscaleMessage={spatialPreview?.auto_downscale_message}
      fallbackAutoDownscaleMessage={tp.liveState?.preview_auto_downscale_message}
      previewGrid={vp.previewGrid}
      previewMessage={vp.previewMessage}
      previewIsStale={vp.previewIsStale}
      previewIsInitialSampleStale={vp.previewIsInitialSampleStale}
    />
  ) : null;

  const handleTabValueChange = useCallback(
    (nextId: string) => {
      activateTab(currentStage, nextId);
      const nextTab = tabs.find((tab) => tab.id === nextId) ?? null;
      const slug = workspaceRouteSlugForTab(nextTab);
      if (!slug) {
        return;
      }
      const nextHref = workspaceHrefForTabSlug(slug);
      if (pathname !== nextHref) {
        router.replace(nextHref, { scroll: false });
      }
    },
    [activateTab, currentStage, pathname, router, tabs],
  );

  if (!dockCenterFlags.enableInternalTree) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        DockCenterTabs internal tree disabled
      </div>
    );
  }

  if (flagsLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        Loading...
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

  if (!dockCenterFlags.enableTabsShell) {
    const tab = activeTab ?? tabs[0]!;
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
        {FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar && !activeTabIsCharts ? (
          <ViewportBar />
        ) : null}
        {previewNotices}
        <div className="min-h-0 min-w-0 flex-1">{renderTabContent(tab, true)}</div>
      </div>
    );
  }

  const tabsNode = (
    <Tabs
      value={activeTab?.id}
      onValueChange={handleTabValueChange}
      variant="pill"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <DockCenterTabHeader
        stage={currentStage}
        tabs={tabs}
        flags={dockCenterFlags}
        onCloseTab={closeTab}
      />

      {tabs.map((tab) => {
        const renderDecision = resolveWorkspaceTabRenderDecision(tab, activeTab?.id);
        if (!renderDecision.render) {
          return null;
        }
        return (
          <TabsContent
            key={tab.id}
            value={tab.id}
            forceMount={renderDecision.forceMount}
            hidden={false}
            aria-hidden={!renderDecision.visible}
            className={[
              "relative mt-0 flex min-h-0 min-w-0 flex-1 flex-col",
              renderDecision.visible
                ? ""
                : "pointer-events-none absolute inset-0 h-full w-full overflow-hidden opacity-0 [visibility:hidden]",
            ].join(" ")}
          >
            {renderTabContent(tab, renderDecision.visible)}

            {dockCenterFlags.enablePinOverlayButton && tab.closable ? (
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
            ) : null}
          </TabsContent>
        );
      })}
    </Tabs>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar && !activeTabIsCharts ? (
        <ViewportBar />
      ) : null}
      {previewNotices}
      {dockCenterFlags.enableTooltipProvider ? (
        <TooltipProvider delayDuration={300}>{tabsNode}</TooltipProvider>
      ) : (
        tabsNode
      )}
    </div>
  );
}

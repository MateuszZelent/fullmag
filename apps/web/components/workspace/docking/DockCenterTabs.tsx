"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

import { ViewportBar } from "@/components/runs/control-room/ViewportPanels";
import { useModel, useTransport, useViewport } from "@/components/runs/control-room/context-hooks";
import EmptyState from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { useRuntimeFeatureFlags } from "@/lib/hooks/useRuntimeFeatureFlags";
import { useWebGLWarmKeepAliveDisabledForSession } from "@/lib/viewport/webglWarmKeepAliveGuard";
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
import { useDockCenterTabSelection } from "./center-tabs/useDockCenterTabSelection";

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
  const webGLWarmKeepAliveDisabledByContextLoss = useWebGLWarmKeepAliveDisabledForSession();

  const vp = useViewport();
  const model = useModel();
  const tp = useTransport();
  const featureFlags = useRuntimeFeatureFlags();

  const currentWorkspaceMode = vp.workspaceMode;
  const effectiveViewMode = vp.effectiveViewMode;
  const selectedQuantity = vp.selectedQuantity;
  const setWorkspaceMode = vp.setWorkspaceMode;
  const handleViewModeChange = vp.handleViewModeChange;
  const requestPreviewQuantity = vp.requestPreviewQuantity;
  const activeResultWorkspaceId = model.activeResultWorkspaceId;
  const analyzeSelection = model.analyzeSelection;
  const openAnalyzeSurface = model.openAnalyzeSurface;

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
      keepAlive: false,
      lifecycle: "unmount-on-hide",
      payload: { viewMode: "Analyze" },
    });
  }, [
    currentStage,
    dockCenterFlags.enableEnsureChartsTabEffect,
    dockCenterFlags.enableInternalTree,
    openTab,
    tabs,
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

  const spatialPreview = tp.preview?.kind === "spatial" ? tp.preview : null;
  const previewNoticesVisible =
    FRONTEND_DIAGNOSTIC_FLAGS.shell.showPreviewNotices && dockCenterFlags.showPreviewNotices;

  // P-22: Track recently activated WebGL tabs in LRU order so that warm-hide keeps the most
  // recently used tabs alive rather than the last N tabs by array index.
  const recentWebGLTabIdsRef = useRef<string[]>([]);
  useEffect(() => {
    if (!activeTab || !isWebGLWorkspaceTab(activeTab)) return;
    const id = activeTab.id;
    recentWebGLTabIdsRef.current = [
      id,
      ...recentWebGLTabIdsRef.current.filter((tid) => tid !== id),
    ].slice(0, 8); // Keep reasonable history for large tab sets
  }, [activeTab]);

  const activeTabIsCharts = activeTab?.kind === "viewport-charts";
  const warmWebGLTabIds = useMemo(() => {
    if (
      !dockCenterFlags.enableWebGLWarmKeepAlive ||
      webGLWarmKeepAliveDisabledByContextLoss ||
      !activeTab
    ) {
      return null;
    }
    const budget = Math.max(0, dockCenterFlags.webGLWarmKeepAliveHiddenTabLimit ?? 1);
    // FF-1: Firefox loses WebGL contexts when multiple renderers are active. Force
    // budget=0 on Firefox so hidden tabs are never warm-mounted there.
    const isFirefox = typeof navigator !== "undefined" && navigator.userAgent.includes("Firefox");
    const effectiveBudget = isFirefox ? 0 : budget;
    const ids = new Set<string>();
    // LRU policy: prefer most-recently-activated WebGL tabs (recentWebGLTabIdsRef is updated by
    // the effect above; reads stale value here but tabs[]-based fallback fills any gap).
    for (const recentId of recentWebGLTabIdsRef.current) {
      if (ids.size >= effectiveBudget) break;
      if (recentId === activeTab.id) continue;
      const tab = tabs.find((t) => t.id === recentId);
      if (tab && isWebGLWorkspaceTab(tab)) {
        ids.add(recentId);
      }
    }
    // Fallback: fill remaining budget from tabs array (last-to-first) for tabs not yet in LRU list
    for (let index = tabs.length - 1; index >= 0 && ids.size < effectiveBudget; index -= 1) {
      const tab = tabs[index];
      if (!tab || tab.id === activeTab.id || !isWebGLWorkspaceTab(tab)) {
        continue;
      }
      ids.add(tab.id);
    }
    return ids;
  }, [
    activeTab,
    dockCenterFlags.enableWebGLWarmKeepAlive,
    dockCenterFlags.webGLWarmKeepAliveHiddenTabLimit,
    tabs,
    webGLWarmKeepAliveDisabledByContextLoss,
  ]);

  const renderTabContent = (tab: WorkspaceTab, viewportVisible = tab.id === activeTab?.id) => (
    <DockCenterTabContent
      tab={tab}
      flags={dockCenterFlags}
      chartsDisabled={chartsDisabled}
      preview3dDisabled={preview3dDisabled}
      viewportVisible={viewportVisible}
    />
  );

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
        const renderDecision = resolveWorkspaceTabRenderDecision(tab, activeTab?.id, {
          enableWebGLWarmKeepAlive: dockCenterFlags.enableWebGLWarmKeepAlive,
          warmWebGLTabIds,
          webGLWarmKeepAliveDisabledByContextLoss,
        });
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

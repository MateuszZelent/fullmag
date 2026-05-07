"use client";

import React, { useCallback, useMemo, useEffect, useRef } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorkspaceMode } from "../runs/control-room/context-hooks";
import { RibbonTabStrip, type ContextualRibbonTab } from "./ribbon/RibbonTabStrip";
import { RibbonGroupsRow } from "./ribbon/RibbonGroupsRow";
import { useRibbonGroups } from "./ribbon/useRibbonGroups";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import type {
  AirboxDisplayScope,
  RibbonCommandContext,
  ViewportMeshRenderMode,
} from "./ribbon/command-registry";
import { useGeometryCapabilities } from "@/src/hooks/resources/useSceneDocument";
import { useWorkspaceRibbon } from "@/src/hooks/resources/useWorkspaceRibbon";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";
import type { Slice2DDiagnostics, Slice2DToolbarState } from "@/src/features/slice2d";
import type { VisualizationAction } from "@/components/runs/control-room/visualizationReducer";
import {
  parseNodeIdToTarget,
  ribbonContextForTarget,
  type RibbonCoreTab,
} from "@/features/interaction/model/selection";

// ── Registry imports ──
import {
  type RibbonTabId,
} from "@/features/shell/registry/ribbonRegistry";
// Side-effect: registers all contributions
import "@/features/shell/contributions";

/* ── Types ──────────────────────────────────────── */

type RibbonTab =
  | "Home"
  | "View"
  | "Definitions"
  | "Geometry"
  | "Materials"
  | "Physics"
  | "Mesh"
  | "Study"
  | "Results"
  | "Automation";

export interface RibbonBarProps extends RibbonCommandContext {
  femDiscretization?: boolean;
  solverRunning?: boolean;
  sidebarVisible?: boolean;
  selectedNodeId?: string | null;
  meshConfigDirty?: boolean;
  runLabel?: string;
  viewport3DStatus?: "active" | "inactive" | "warning";
  viewport3DStatusReason?: string | null;
  viewport3DStatusDetail?: string | null;
  quickPreviewTargets?: Array<{
    id: string;
    shortLabel: string;
    available: boolean;
  }>;
  selectedQuantity?: string;
  requestedPreviewComponent?: string | null;
  requestedPreviewEveryN?: number | null;
  requestedPreviewAutoScale?: boolean | null;
  requestedPreviewQuantityDataStatus?: string | null;
  magneticTextureVisible?: boolean;
  magneticTextureDensity?: number | null;
  quantityShaderVisible?: boolean;
  requestedPreviewMaxPoints?: number | null;
  selectedObjectTextureVisible?: boolean | null;
  selectedObjectOpacity?: number | null;
  selectedObjectRenderMode?: ViewportMeshRenderMode | "inherit" | null;
  airMeshRenderMode?: ViewportMeshRenderMode | null;
  airMeshGeometryVisible?: boolean | null;
  airMeshSurfaceVisible?: boolean | null;
  airMeshWireframeVisible?: boolean | null;
  airMeshPointsVisible?: boolean | null;
  airMeshVectorsVisible?: boolean | null;
  airMeshWireframeScope?: AirboxDisplayScope | null;
  airMeshPointsScope?: AirboxDisplayScope | null;
  airMeshVectorsScope?: AirboxDisplayScope | null;
  slice2DEnabled?: boolean;
  slice2DToolbar?: Slice2DToolbarState | null;
  slice2DDiagnostics?: Slice2DDiagnostics | null;
  previewPending?: boolean;
  antennaSources?: Array<{
    name: string;
    kind: string;
    currentA: number;
  }>;
  selectedAntennaName?: string | null;
  meshTargetLabel?: string | null;
  sceneObjectCount?: number;
  hasSharedAirboxDomain?: boolean;
  workspaceMode?: WorkspaceMode;
  onDispatchVisualization?: (action: VisualizationAction) => void;
}

/* ── Helpers ──────────────────────────────────────── */

const RIBBON_TAB_TO_ID: Record<RibbonTab, RibbonTabId> = {
  Home: "home",
  View: "view",
  Definitions: "definitions",
  Geometry: "geometry",
  Materials: "materials",
  Physics: "physics",
  Mesh: "mesh",
  Study: "study",
  Results: "results",
  Automation: "automation",
};

const RIBBON_CORE_TAB_TO_TAB: Record<RibbonCoreTab, RibbonTab> = {
  home: "Home",
  definitions: "Definitions",
  geometry: "Geometry",
  materials: "Materials",
  physics: "Physics",
  mesh: "Mesh",
  study: "Study",
  results: "Results",
  automation: "Automation",
};

function tabsForMode(mode: WorkspaceMode | undefined): RibbonTab[] {
  void mode;
  return [
    "Home",
    "View",
    "Definitions",
    "Geometry",
    "Materials",
    "Physics",
    "Mesh",
    "Study",
    "Results",
    "Automation",
  ];
}

export function contextualTabsForSelection(p: Pick<RibbonBarProps, "selectedNodeId">): ContextualRibbonTab[] {
  const target = parseNodeIdToTarget(p.selectedNodeId ?? null);
  const tabs: ContextualRibbonTab[] = [];
  switch (target.kind) {
    case "outer_boundary":
    case "interface_boundary":
      tabs.push({ id: "interface", label: "Interface" });
      break;
    case "work_plane":
      tabs.push({ id: "work-plane", label: "Work Plane" });
      break;
    case "mesh_quality":
      tabs.push({ id: "mesh-quality", label: target.label });
      break;
  }
  // Plot/Table contextual tabs removed — charts and tables are accessed
  // directly via the dock center tab bar, not via ribbon context tabs.
  return tabs;
}

export function ribbonTabForSelectedNode(nodeId: string | null | undefined): RibbonTab | null {
  const target = parseNodeIdToTarget(nodeId ?? null);
  const context = ribbonContextForTarget(target);
  return RIBBON_CORE_TAB_TO_TAB[context.coreTab] ?? null;
}

function workspaceRibbonIdentity(value: {
  workspace_mode?: string | null;
  active_core_tab?: string | null;
  active_contextual_tab?: string | null;
} | null | undefined): string {
  return JSON.stringify([
    value?.workspace_mode ?? null,
    value?.active_core_tab ?? null,
    value?.active_contextual_tab ?? null,
  ]);
}

function workspaceRibbonTabIdentity(value: {
  active_core_tab?: string | null;
  active_contextual_tab?: string | null;
} | null | undefined): string {
  return JSON.stringify([
    value?.active_core_tab ?? null,
    value?.active_contextual_tab ?? null,
  ]);
}

/** Map workspace mode to its default ribbon tab (when no manual override). */
function defaultTabForMode(mode: WorkspaceMode | undefined): RibbonTab {
  switch (mode) {
    case "build": return "Geometry";
    case "study": return "Study";
    default: return "Results";
  }
}

function isRibbonTabVisibleForMode(
  mode: WorkspaceMode | undefined,
  tab: string | null | undefined,
): tab is RibbonTab {
  return Boolean(tab) && tabsForMode(mode).includes(tab as RibbonTab);
}

/* ── Component ──────────────────────────────────── */

export default function RibbonBar(props: RibbonBarProps) {
  const sessionId = useSessionRuntimeStore((s) => s.session?.session_id ?? null);
  const workspaceRevision = useSessionRuntimeStore(
    (s) => s.resourceRevisions?.workspace_revision ?? null,
  );
  const sceneRevision = useSessionRuntimeStore(
    (s) => s.resourceRevisions?.scene_revision ?? null,
  );
  const currentStage = useWorkspaceStore((s) => s.currentStage);
  const activeCoreTab = useWorkspaceStore((s) => s.activeCoreTab);
  const setActiveCoreTab = useWorkspaceStore((s) => s.setActiveCoreTab);
  const activeContextualTab = useWorkspaceStore((s) => s.activeContextualTab);
  const setActiveContextualTab = useWorkspaceStore((s) => s.setActiveContextualTab);
  const {
    ribbon: workspaceRibbon,
    error: workspaceRibbonError,
    loading: workspaceRibbonLoading,
    replaceRibbon: replaceWorkspaceRibbon,
  } = useWorkspaceRibbon({
    enabled: true,
    sessionKey: sessionId,
    revision: workspaceRevision,
  });
  const { capabilities: geometryCapabilities } = useGeometryCapabilities({
    enabled: true,
    sessionKey: sessionId,
    revision: sceneRevision,
  });
  const workspaceRibbonHydratingRef = useRef(false);
  const lastPersistedWorkspaceRibbonRef = useRef<string | null>(null);
  const lastHydratedWorkspaceRibbonRevisionRef = useRef<number | null>(null);
  const lastSessionIdRef = useRef<string | null>(null);
  const builderEnabled = useGeometryBuilderStore((s) => s.builderMode.enabled);
  const builderDirtyGeometry = useGeometryBuilderStore(
    (s) => s.dirty.geometryDraftDirty || s.dirty.geometryRealizationDirty,
  );
  const builderDirtyMesh = useGeometryBuilderStore((s) => s.dirty.meshDirty);
  const builderHasRealization = useGeometryBuilderStore((s) => s.geometryRealization !== null);
  const builderSceneObjectCount = props.sceneObjectCount ?? 0;
  const builderSelectedPrimitiveId = useGeometryBuilderStore((s) =>
    s.builderSelection.type === "primitive" ? s.builderSelection.id : null,
  );
  const workspaceStage = props.workspaceMode ?? currentStage;

  // ── Auto-activate ribbon tab when selected sidebar node changes ──
  const prevAutoActivateNodeIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (builderEnabled && activeCoreTab === "Geometry") {
      return;
    }
    const nodeId = props.selectedNodeId ?? null;
    if (!nodeId || nodeId === prevAutoActivateNodeIdRef.current) {
      return;
    }
    prevAutoActivateNodeIdRef.current = nodeId;
    const targetTab = ribbonTabForSelectedNode(nodeId);
    if (targetTab) {
      const currentVisible = tabsForMode(workspaceStage);
      if (currentVisible.includes(targetTab)) {
        setActiveCoreTab(targetTab);
      }
    }
  }, [activeCoreTab, builderEnabled, props.selectedNodeId, workspaceStage, setActiveCoreTab]);

  useEffect(() => {
    if (lastSessionIdRef.current === sessionId) {
      return;
    }
    lastSessionIdRef.current = sessionId;
    lastPersistedWorkspaceRibbonRef.current = null;
    lastHydratedWorkspaceRibbonRevisionRef.current = null;
    workspaceRibbonHydratingRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      lastPersistedWorkspaceRibbonRef.current = null;
      lastHydratedWorkspaceRibbonRevisionRef.current = null;
      workspaceRibbonHydratingRef.current = false;
      return;
    }
    if (!workspaceRibbon) {
      return;
    }
    if (lastHydratedWorkspaceRibbonRevisionRef.current === workspaceRibbon.revision) {
      return;
    }
    if (workspaceRibbon.workspace_mode !== workspaceStage) {
      lastHydratedWorkspaceRibbonRevisionRef.current = workspaceRibbon.revision;
      return;
    }
    const nextActiveCoreTab = isRibbonTabVisibleForMode(
      workspaceStage,
      workspaceRibbon.active_core_tab,
    )
      ? workspaceRibbon.active_core_tab
      : defaultTabForMode(workspaceStage);
    const nextIdentity = workspaceRibbonIdentity(workspaceRibbon);
    lastPersistedWorkspaceRibbonRef.current = nextIdentity;
    const currentIdentity = workspaceRibbonTabIdentity({
      active_core_tab: activeCoreTab,
      active_contextual_tab: activeContextualTab,
    });
    // Workspace mode is owned by the workspace shell/router path. Ribbon resource
    // hydration may restore tab state, but it must not push stage changes back
    // into the broader workspace store from inside the ribbon component.
    if (
      currentIdentity ===
      workspaceRibbonTabIdentity({
        active_core_tab: nextActiveCoreTab,
        active_contextual_tab: workspaceRibbon.active_contextual_tab,
      })
    ) {
      lastHydratedWorkspaceRibbonRevisionRef.current = workspaceRibbon.revision;
      return;
    }
    lastHydratedWorkspaceRibbonRevisionRef.current = workspaceRibbon.revision;
    workspaceRibbonHydratingRef.current = true;
    setActiveCoreTab(nextActiveCoreTab);
    setActiveContextualTab(workspaceRibbon.active_contextual_tab ?? null);
    queueMicrotask(() => {
      workspaceRibbonHydratingRef.current = false;
    });
  }, [
    activeContextualTab,
    activeCoreTab,
    sessionId,
    setActiveContextualTab,
    setActiveCoreTab,
    workspaceRibbon,
    workspaceStage,
  ]);

  useEffect(() => {
    if (
      !sessionId
      || workspaceRibbonLoading
      || workspaceRibbonHydratingRef.current
      || workspaceRibbonError
    ) {
      return;
    }
    const nextIdentity = workspaceRibbonIdentity({
      workspace_mode: workspaceStage,
      active_core_tab: activeCoreTab,
      active_contextual_tab: activeContextualTab,
    });
    if (lastPersistedWorkspaceRibbonRef.current === nextIdentity) {
      return;
    }
    lastPersistedWorkspaceRibbonRef.current = nextIdentity;
    void replaceWorkspaceRibbon({
      workspace_mode: workspaceStage,
      active_core_tab: activeCoreTab,
      active_contextual_tab: activeContextualTab,
    }).then((persisted) => {
      if (persisted) {
        lastPersistedWorkspaceRibbonRef.current = workspaceRibbonIdentity(persisted);
      }
    });
  }, [
    activeContextualTab,
    activeCoreTab,
    replaceWorkspaceRibbon,
    sessionId,
    workspaceRibbonError,
    workspaceRibbonLoading,
    workspaceStage,
  ]);

  const visibleTabs = useMemo(() => tabsForMode(workspaceStage), [workspaceStage]);
  const defaultTab = defaultTabForMode(workspaceStage);
  const contextualTabs = useMemo(
    () => contextualTabsForSelection(props),
    // Only the fields contextualTabsForSelection actually reads:
    [props.selectedNodeId],
  );
  const activeTab = activeCoreTab && visibleTabs.includes(activeCoreTab as RibbonTab)
    ? (activeCoreTab as RibbonTab)
    : defaultTab;
  const activeContextualTabId =
    contextualTabs.length === 0
      ? null
      : activeContextualTab && contextualTabs.some((tab) => tab.id === activeContextualTab)
        ? activeContextualTab
        : contextualTabs[0]?.id ?? null;
  const handleCoreTabClick = useCallback(
    (tab: string) => {
      setActiveCoreTab(tab);
    },
    [setActiveCoreTab],
  );
  const groups = useRibbonGroups(props, {
    activeTabId: RIBBON_TAB_TO_ID[activeTab],
    activeContextualTabId,
    builderEnabled,
    builderDirtyGeometry,
    builderDirtyMesh,
    builderHasRealization,
    builderSceneObjectCount,
    builderSelectedPrimitiveId,
    geometryCapabilities,
  });

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-[130px] w-full shrink-0 flex-col overflow-hidden border-b border-border/15 bg-card/10 backdrop-blur-xl z-30">
        <RibbonTabStrip
          visibleTabs={visibleTabs}
          activeTab={activeTab}
          onTabClick={handleCoreTabClick}
          contextualTabs={contextualTabs}
          activeContextualTabId={activeContextualTabId}
          onContextualTabClick={setActiveContextualTab}
          meshGenerating={props.meshGenerating}
          meshConfigDirty={props.meshConfigDirty}
        />
        <RibbonGroupsRow groups={groups} previewPending={props.previewPending} />
      </div>
    </TooltipProvider>
  );
}

"use client";

import React, { useCallback, useMemo, useEffect, useRef } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorkspaceMode } from "../runs/control-room/context-hooks";
import { RibbonTabStrip, type ContextualRibbonTab } from "./ribbon/RibbonTabStrip";
import { RibbonGroupsRow } from "./ribbon/RibbonGroupsRow";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import {
  parseStudyNodeContext,
} from "@/lib/study-builder/node-context";
import {
  canExecuteRibbonCommand,
  executeRibbonCommand,
  type AirboxDisplayPatch,
  type RibbonCommand,
  type ViewportMeshRenderMode,
} from "./ribbon/command-registry";
import type { MagneticPresetKind } from "@/lib/magnetizationPresetCatalog";
import type { ScriptBuilderMagneticInteractionKind } from "@/lib/session/types";
import type { StudyPrimitiveStageKind } from "@/lib/study-builder/types";
import type { BooleanOp, PrimitiveKind } from "@/features/geometry-builder/model/types";
import type { CapabilityMap, GeometryCapabilitiesResource } from "@/src/api/types";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import { useGeometryCapabilities } from "@/src/hooks/resources/useSceneDocument";
import { useWorkspaceRibbon } from "@/src/hooks/resources/useWorkspaceRibbon";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";
import type { Slice2DDiagnostics, Slice2DToolbarState } from "@/src/features/slice2d";

// ── Registry imports ──
import {
  resolveRibbonGroups,
  type RibbonTabId,
  type ContextualTabId,
  type RibbonBuildContext,
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

interface RibbonBarProps {
  viewMode?: string;
  femDiscretization?: boolean;
  domainCapabilities?: CapabilityMap | null;
  solverRunning?: boolean;
  sidebarVisible?: boolean;
  selectedNodeId?: string | null;
  canRun?: boolean;
  canRelax?: boolean;
  canPause?: boolean;
  canStop?: boolean;
  canSkip?: boolean;
  runAction?: string;
  runLabel?: string;
  onViewChange?: (mode: string) => void;
  onSidebarToggle?: () => void;
  onCreateVisualizationPreset?: () => void;
  airboxVisible?: boolean;
  viewportAxesScope?: "universe" | "object";
  universeWireframeVisible?: boolean;
  viewportLegendVisible?: boolean;
  onToggleAirbox?: () => void;
  onSetViewportAxesScope?: (scope: "universe" | "object") => void;
  onToggleUniverseWireframe?: () => void;
  onToggleViewportLegend?: () => void;
  onSimAction?: (action: string) => void;
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
  quantityShaderVisible?: boolean;
  meshRenderMode?: string | null;
  meshOpacity?: number | null;
  selectedObjectOpacity?: number | null;
  selectedObjectRenderMode?: ViewportMeshRenderMode | "inherit" | null;
  meshClipEnabled?: boolean | null;
  meshClipAxis?: "x" | "y" | "z" | null;
  meshClipPos?: number | null;
  meshClipFlip?: boolean | null;
  meshShowArrows?: boolean | null;
  femArrowColorMode?: string | null;
  femArrowMonoColor?: string | null;
  femArrowAlpha?: number | null;
  femArrowLengthScale?: number | null;
  femArrowThickness?: number | null;
  femVectorDomainFilter?: string | null;
  femFerromagnetVisibilityMode?: string | null;
  airMeshOpacity?: number | null;
  airMeshRenderMode?: ViewportMeshRenderMode | null;
  slice2DEnabled?: boolean;
  slice2DToolbar?: Slice2DToolbarState | null;
  slice2DDiagnostics?: Slice2DDiagnostics | null;
  previewPending?: boolean;
  onQuickPreviewSelect?: (quantityId: string) => void;
  onSetPreviewComponent?: (component: "3D" | "x" | "y" | "z" | "magnitude") => void;
  onSetPreviewEveryN?: (everyN: number) => void;
  onSetPreviewColormap?: (colormap: string) => void;
  onSetPreviewAutoScale?: (enabled: boolean) => void;
  onSetQuantityShaderVisible?: (visible: boolean) => void;
  onExport?: () => void;
  onCapture?: () => void;
  onStateExport?: () => void;
  antennaSources?: Array<{
    name: string;
    kind: string;
    currentA: number;
  }>;
  selectedAntennaName?: string | null;
  onAddAntenna?: (kind: "MicrostripAntenna" | "CPWAntenna") => void;
  onSelectModelNode?: (nodeId: string) => void;
  meshGenerating?: boolean;
  meshConfigDirty?: boolean;
  meshTargetLabel?: string | null;
  onBuildMeshSelected?: () => void;
  onBuildMeshAll?: () => void;
  onOpenMeshInspector?: () => void;
  onOpenMeshStatistics?: () => void;
  onOpenMeshQuality?: () => void;
  onOpenMeshSizeSettings?: () => void;
  onOpenMeshTransitionSettings?: () => void;
  onOpenMeshMethodSettings?: () => void;
  onOpenMeshOptimizationSettings?: () => void;
  onOpenMeshPipeline?: () => void;
  selectedObjectId?: string | null;
  sceneObjectCount?: number;
  onRequestObjectFocus?: (objectId: string) => void;
  hasSharedAirboxDomain?: boolean;
  canSyncScriptBuilder?: boolean;
  scriptSyncBusy?: boolean;
  onSyncScriptBuilder?: () => void;
  workspaceMode?: WorkspaceMode;
  onStudyAddPrimitive?: (
    kind: StudyPrimitiveStageKind,
    placement: "append" | "before" | "after",
  ) => void;
  onStudyAddMacro?: (
    kind:
      | "hysteresis_loop"
      | "field_sweep_relax"
      | "field_sweep_relax_snapshot"
      | "relax_run"
      | "relax_eigenmodes"
      | "parameter_sweep"
      | "current_sweep_run"
      | "dc_bias_plus_rf_probe",
    placement: "append" | "before" | "after",
  ) => void;
  onStudyDuplicateSelected?: () => void;
  onStudyToggleSelectedEnabled?: () => void;
  onAddResultAnalysis?: (
    kind:
      | "spectrum"
      | "dispersion"
      | "modes"
      | "time-traces"
      | "vortex-frequency"
      | "vortex-trajectory"
      | "vortex-orbit"
      | "quantity"
      | "table",
  ) => void;
  onObjectAddInteraction?: (
    objectId: string,
    kind: ScriptBuilderMagneticInteractionKind,
  ) => void;
  onAssignMagnetizationPreset?: (
    objectId: string,
    kind: MagneticPresetKind,
  ) => void;
  activeTransformScope?: "object" | "texture" | null;
  onSetTransformScope?: (
    scope: "camera" | "object" | "texture",
  ) => void;
  onSetMeshRenderMode?: (mode: ViewportMeshRenderMode) => void;
  onSetMeshOpacity?: (opacity: number) => void;
  onSetSelectedObjectOpacity?: (opacity: number) => void;
  onSetSelectedObjectRenderMode?: (mode: ViewportMeshRenderMode | "inherit") => void;
  onClearSelectedDisplayOverrides?: () => void;
  onSetMeshClipEnabled?: (enabled: boolean) => void;
  onSetMeshClipAxis?: (axis: "x" | "y" | "z") => void;
  onSetMeshClipPos?: (position: number) => void;
  onSetMeshClipFlip?: (flipped: boolean) => void;
  onSetMeshShowArrows?: (visible: boolean) => void;
  onSetFemArrowStyle?: (patch: Partial<{
    colorMode: "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
    monoColor: string;
    alpha: number;
    lengthScale: number;
    thickness: number;
    domain: "auto" | "magnetic_only" | "full_domain" | "airbox_only";
    ferromagnetVisibility: "hide" | "ghost";
  }>) => void;
  onSetAirboxDisplay?: (patch: AirboxDisplayPatch) => void;
  onSetSlice2DToolbar?: (patch: Partial<Slice2DToolbarState>) => void;
  onSetTextureTransformMode?: (
    objectId: string,
    mode: "translate" | "rotate" | "scale",
  ) => void;
  // Geometry Builder callbacks
  onBuilderAddPrimitive?: (kind: PrimitiveKind) => void;
  onBuilderCreateBoolean?: (op: BooleanOp) => void;
  onBuilderRemovePrimitive?: (id: string) => void;
  onBuilderDuplicatePrimitive?: (id: string) => void;
  onBuilderBuildGeometry?: () => void;
  onBuilderBuildMesh?: () => void;
  onBuilderBuildAll?: () => void;
  onBuilderValidateGeometry?: () => void;
  onBuilderSetViewportMode?: (mode: "camera" | "manipulate") => void;
  onBuilderSetTransformTool?: (tool: "move" | "rotate" | "scale") => void;
  onBuilderToggleSnap?: () => void;
  onBuilderFocusSelected?: () => void;
  onBuilderFrameAll?: () => void;
  onBuilderCenterInUniverse?: (id: string) => void;
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

function contextualTabsForSelection(p: RibbonBarProps): ContextualRibbonTab[] {
  const nodeId = p.selectedNodeId ?? "";
  const tabs: ContextualRibbonTab[] = [];
  if (nodeId.includes("interface") || nodeId.includes("boundary")) {
    tabs.push({ id: "interface", label: "Interface" });
  }
  if (nodeId.includes("work-plane") || nodeId.includes("plane")) {
    tabs.push({ id: "work-plane", label: "Work Plane" });
  }
  if (
    nodeId.includes("mesh-statistics")
    || nodeId === "universe-mesh-statistics"
  ) {
    tabs.push({ id: "mesh-quality", label: "Mesh Statistics" });
  } else if (
    nodeId.includes("mesh-quality")
    || nodeId === "mesh-pipeline"
    || nodeId === "universe-mesh-quality"
    || nodeId === "universe-mesh-pipeline"
  ) {
    tabs.push({ id: "mesh-quality", label: "Mesh Quality" });
  }
  // Plot/Table contextual tabs removed — charts and tables are accessed
  // directly via the dock center tab bar, not via ribbon context tabs.
  return tabs;
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

/** Build a RibbonBuildContext from the current RibbonBarProps. */
function buildContext(
  props: RibbonBarProps,
  builderState: {
    builderEnabled: boolean;
    builderDirtyGeometry: boolean;
    builderDirtyMesh: boolean;
    builderHasRealization: boolean;
    builderSceneObjectCount: number;
    builderSelectedPrimitiveId: string | null;
    geometryCapabilities: GeometryCapabilitiesResource | null;
  },
): RibbonBuildContext {
  const run = (command: RibbonCommand) => {
    executeRibbonCommand(props, command);
  };
  const can = (command: RibbonCommand) => canExecuteRibbonCommand(props, command);

  return {
    isFemBackend: resolveFemDiscretization(
      props.domainCapabilities,
      Boolean(props.femDiscretization),
    ),
    domainCapabilities: props.domainCapabilities ?? null,
    canRun: Boolean(props.canRun),
    canRelax: Boolean(props.canRelax),
    canPause: Boolean(props.canPause),
    canStop: Boolean(props.canStop),
    canSkip: Boolean(props.canSkip),
    runAction: props.runAction ?? "run",
    runLabel: props.runLabel ?? "Run",

    meshGenerating: Boolean(props.meshGenerating),
    meshConfigDirty: Boolean(props.meshConfigDirty),
    meshTargetLabel: props.meshTargetLabel ?? null,

    selectedObjectId: props.selectedObjectId ?? null,
    selectedNodeId: props.selectedNodeId ?? null,
    selectedNodeKind: null, // resolved from handle if needed
    activeTransformScope: props.activeTransformScope ?? null,

    viewMode: props.viewMode ?? null,
    sidebarVisible: Boolean(props.sidebarVisible),
    previewPending: Boolean(props.previewPending),
    airboxVisible: Boolean(props.airboxVisible),
    quantityShaderVisible: props.quantityShaderVisible ?? true,
    viewportAxesScope: props.viewportAxesScope ?? "universe",
    universeWireframeVisible: props.universeWireframeVisible ?? true,
    viewportLegendVisible: Boolean(props.viewportLegendVisible),

    studyNodeContext: parseStudyNodeContext(props.selectedNodeId),

    quickPreviewTargets: props.quickPreviewTargets ?? [],
    selectedQuantity: props.selectedQuantity ?? null,
    requestedPreviewComponent: props.requestedPreviewComponent ?? null,
    requestedPreviewEveryN: props.requestedPreviewEveryN ?? null,
    requestedPreviewAutoScale: props.requestedPreviewAutoScale ?? null,
    requestedPreviewQuantityDataStatus: props.requestedPreviewQuantityDataStatus ?? null,
    meshRenderMode: props.meshRenderMode ?? null,
    meshOpacity: props.meshOpacity ?? null,
    selectedObjectOpacity: props.selectedObjectOpacity ?? null,
    selectedObjectRenderMode: props.selectedObjectRenderMode ?? null,
    meshClipEnabled: props.meshClipEnabled ?? null,
    meshClipAxis: props.meshClipAxis ?? null,
    meshClipPos: props.meshClipPos ?? null,
    meshClipFlip: props.meshClipFlip ?? null,
    meshShowArrows: props.meshShowArrows ?? null,
    femArrowColorMode: props.femArrowColorMode ?? null,
    femArrowMonoColor: props.femArrowMonoColor ?? null,
    femArrowAlpha: props.femArrowAlpha ?? null,
    femArrowLengthScale: props.femArrowLengthScale ?? null,
    femArrowThickness: props.femArrowThickness ?? null,
    femVectorDomainFilter: props.femVectorDomainFilter ?? null,
    femFerromagnetVisibilityMode: props.femFerromagnetVisibilityMode ?? null,
    airMeshOpacity: props.airMeshOpacity ?? null,
    airMeshRenderMode: props.airMeshRenderMode ?? null,
    slice2DEnabled: Boolean(props.slice2DEnabled),
    slice2DToolbar: props.slice2DToolbar ?? null,
    slice2DDiagnostics: props.slice2DDiagnostics ?? null,

    antennaSources: props.antennaSources ?? [],
    selectedAntennaName: props.selectedAntennaName ?? null,

    canSyncScriptBuilder: Boolean(props.canSyncScriptBuilder),
    scriptSyncBusy: Boolean(props.scriptSyncBusy),

    builderEnabled: builderState.builderEnabled,
    builderDirtyGeometry: builderState.builderDirtyGeometry,
    builderDirtyMesh: builderState.builderDirtyMesh,
    builderHasRealization: builderState.builderHasRealization,
    builderSceneObjectCount: builderState.builderSceneObjectCount,
    builderSelectedPrimitiveId: builderState.builderSelectedPrimitiveId,
    geometryCapabilities: builderState.geometryCapabilities,

    run,
    can,
  };
}

/** Map workspace mode to its default ribbon tab (when no manual override). */
function defaultTabForMode(mode: WorkspaceMode | undefined): RibbonTab {
  switch (mode) {
    case "build": return "Geometry";
    case "study": return "Study";
    case "analyze":
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
    const nodeId = props.selectedNodeId ?? "";
    if (!nodeId || nodeId === prevAutoActivateNodeIdRef.current) {
      return;
    }
    prevAutoActivateNodeIdRef.current = nodeId;
    let targetTab: RibbonTab | null = null;
    const lower = nodeId.toLowerCase();
    if (lower.includes("physics") || lower.includes("interaction") || lower.includes("anisotropy") || lower.includes("zeeman") || lower.includes("stochastic")) {
      targetTab = "Physics";
    } else if (lower.includes("material")) {
      targetTab = "Materials";
    } else if (lower.includes("geometry") || (lower.includes("object") && !lower.includes("study"))) {
      targetTab = "Geometry";
    } else if (lower.includes("mesh") && !lower.includes("study")) {
      targetTab = "Mesh";
    } else if (lower.includes("study") || lower.includes("stage")) {
      targetTab = "Study";
    } else if (lower.includes("result") || lower.includes("analysis") || lower.includes("plot") || lower.includes("spectrum") || lower.includes("dispersion")) {
      targetTab = "Results";
    } else if (lower.includes("definition") || lower.includes("parameter") || lower.includes("constant")) {
      targetTab = "Definitions";
    }
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
    [props.selectedNodeId, props.viewMode],
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

  const groups = useMemo(() => {
    const ctx = buildContext(props, {
      builderEnabled,
      builderDirtyGeometry,
      builderDirtyMesh,
      builderHasRealization,
      builderSceneObjectCount,
      builderSelectedPrimitiveId,
      geometryCapabilities,
    });
    const tabId = RIBBON_TAB_TO_ID[activeTab];

    // Resolve core tab groups from registry
    const baseGroups = resolveRibbonGroups(tabId, ctx);

    // Resolve active contextual tab groups
    const ctxTabId = activeContextualTabId as ContextualTabId | null;
    const contextualGroups = ctxTabId
      ? resolveRibbonGroups(ctxTabId, ctx)
      : [];

    const combined = contextualGroups.length > 0
      ? [...baseGroups, ...contextualGroups]
      : baseGroups;

    // Deduplicate by group.id — last occurrence wins (contextual overrides base).
    const seen = new Set<string>();
    const deduped: typeof combined = [];
    for (let i = combined.length - 1; i >= 0; i--) {
      if (!seen.has(combined[i].id)) {
        seen.add(combined[i].id);
        deduped.unshift(combined[i]);
      }
    }
    return deduped;
  }, [
    activeTab,
    activeContextualTabId,
    props.workspaceMode,
    props.viewMode,
    props.airboxVisible,
    props.viewportAxesScope,
    props.universeWireframeVisible,
    props.viewportLegendVisible,
    props.femDiscretization,
    props.solverRunning,
    props.sidebarVisible,
    props.selectedNodeId,
    props.canRun,
    props.canRelax,
    props.canPause,
    props.canStop,
    props.canSkip,
    props.quickPreviewTargets,
    props.selectedQuantity,
    props.requestedPreviewComponent,
    props.requestedPreviewEveryN,
    props.requestedPreviewAutoScale,
    props.requestedPreviewQuantityDataStatus,
    props.quantityShaderVisible,
    props.meshRenderMode,
    props.meshOpacity,
    props.selectedObjectOpacity,
    props.selectedObjectRenderMode,
    props.meshClipEnabled,
    props.meshClipAxis,
    props.meshClipPos,
    props.meshClipFlip,
    props.meshShowArrows,
    props.femArrowColorMode,
    props.femArrowMonoColor,
    props.femArrowAlpha,
    props.femArrowLengthScale,
    props.femArrowThickness,
    props.femVectorDomainFilter,
    props.femFerromagnetVisibilityMode,
    props.airMeshOpacity,
    props.airMeshRenderMode,
    props.slice2DEnabled,
    props.slice2DToolbar,
    props.slice2DDiagnostics,
    props.antennaSources,
    props.selectedAntennaName,
    props.canSyncScriptBuilder,
    props.scriptSyncBusy,
    props.selectedObjectId,
    props.onStudyAddPrimitive,
    props.onStudyAddMacro,
    props.onStudyDuplicateSelected,
    props.onStudyToggleSelectedEnabled,
    props.onObjectAddInteraction,
    props.onAssignMagnetizationPreset,
    props.onSetTextureTransformMode,
    props.onSetPreviewComponent,
    props.onSetPreviewEveryN,
    props.onSetPreviewColormap,
    props.onSetPreviewAutoScale,
    props.onSetQuantityShaderVisible,
    props.onSetMeshRenderMode,
    props.onSetMeshOpacity,
    props.onSetSelectedObjectOpacity,
    props.onSetSelectedObjectRenderMode,
    props.onClearSelectedDisplayOverrides,
    props.onSetMeshClipEnabled,
    props.onSetMeshClipAxis,
    props.onSetMeshClipPos,
    props.onSetMeshClipFlip,
    props.onSetMeshShowArrows,
    props.onSetFemArrowStyle,
    props.onSetAirboxDisplay,
    props.onSetSlice2DToolbar,
    props.onBuilderAddPrimitive,
    props.onBuilderCreateBoolean,
    props.onBuilderBuildGeometry,
    props.onBuilderBuildMesh,
    props.onToggleAirbox,
    props.onSetViewportAxesScope,
    props.onToggleUniverseWireframe,
    props.onToggleViewportLegend,
    props.meshGenerating,
    props.meshConfigDirty,
    props.meshTargetLabel,
    props.runAction,
    props.runLabel,
    props.previewPending,
    builderEnabled,
    builderDirtyGeometry,
    builderDirtyMesh,
    builderHasRealization,
    builderSceneObjectCount,
    builderSelectedPrimitiveId,
    geometryCapabilities,
  ]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col w-full bg-card/10 border-b border-border/15 backdrop-blur-xl shrink-0 z-30">
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

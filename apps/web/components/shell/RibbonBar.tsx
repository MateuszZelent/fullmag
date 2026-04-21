"use client";

import React, { useMemo, useCallback, useEffect, useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { WorkspaceMode } from "../runs/control-room/context-hooks";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import {
  parseStudyNodeContext,
} from "@/lib/study-builder/node-context";
import {
  canExecuteRibbonCommand,
  executeRibbonCommand,
  type RibbonCommand,
} from "./ribbon/command-registry";
import type { MagneticPresetKind } from "@/lib/magnetizationPresetCatalog";
import type { GeometryPresetKind } from "@/lib/geometryPresetCatalog";
import type { ScriptBuilderMagneticInteractionKind } from "@/lib/session/types";
import type { StudyPrimitiveStageKind } from "@/lib/study-builder/types";
import type { CapabilityMap } from "@/src/api/types";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import { useWorkspaceRibbon } from "@/src/hooks/resources/useWorkspaceRibbon";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";

// ── Registry imports ──
import {
  resolveRibbonGroups,
  type RibbonTabId,
  type ContextualTabId,
  type RibbonBuildContext,
  type RibbonAction,
  type RibbonGroup,
} from "@/features/shell/registry/ribbonRegistry";
// Side-effect: registers all contributions
import "@/features/shell/contributions";

/* ── Types ──────────────────────────────────────── */

type RibbonTab =
  | "Home"
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
  onSimAction?: (action: string) => void;
  quickPreviewTargets?: Array<{
    id: string;
    shortLabel: string;
    available: boolean;
  }>;
  selectedQuantity?: string;
  previewPending?: boolean;
  onQuickPreviewSelect?: (quantityId: string) => void;
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
  onOpenMeshQuality?: () => void;
  onOpenMeshSizeSettings?: () => void;
  onOpenMeshMethodSettings?: () => void;
  onOpenMeshPipeline?: () => void;
  selectedObjectId?: string | null;
  onAddGeometryPreset?: (preset: GeometryPresetKind) => void;
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
  onSetTextureTransformMode?: (
    objectId: string,
    mode: "translate" | "rotate" | "scale",
  ) => void;
}

/* ── Helpers ──────────────────────────────────────── */

const RIBBON_TAB_TO_ID: Record<RibbonTab, RibbonTabId> = {
  Home: "home",
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

interface ContextualRibbonTab {
  id: ContextualTabId;
  label: string;
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

function normalizeWorkspaceMode(
  value: string | null | undefined,
): WorkspaceMode {
  return value === "build" || value === "study" || value === "analyze"
    ? value
    : "study";
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

/** Build a RibbonBuildContext from the current RibbonBarProps. */
function buildContext(
  props: RibbonBarProps,
  builderState: {
    builderEnabled: boolean;
    builderDirtyGeometry: boolean;
    builderDirtyMesh: boolean;
    builderHasRealization: boolean;
    builderSelectedPrimitiveId: string | null;
  },
): RibbonBuildContext {
  const run = (command: RibbonCommand) => executeRibbonCommand(props, command);
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

    studyNodeContext: parseStudyNodeContext(props.selectedNodeId),

    quickPreviewTargets: props.quickPreviewTargets ?? [],
    selectedQuantity: props.selectedQuantity ?? null,

    antennaSources: props.antennaSources ?? [],
    selectedAntennaName: props.selectedAntennaName ?? null,

    canSyncScriptBuilder: Boolean(props.canSyncScriptBuilder),
    scriptSyncBusy: Boolean(props.scriptSyncBusy),

    builderEnabled: builderState.builderEnabled,
    builderDirtyGeometry: builderState.builderDirtyGeometry,
    builderDirtyMesh: builderState.builderDirtyMesh,
    builderHasRealization: builderState.builderHasRealization,
    builderSelectedPrimitiveId: builderState.builderSelectedPrimitiveId,

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

/* ── Render helpers ──────────────────────────────── */

const RibbonActionTrigger = React.forwardRef<
  HTMLButtonElement,
  {
    action: RibbonAction;
    previewPending?: boolean;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ action, previewPending, ...props }, ref) => {
  const propsOnClick = props.onClick;
  const isPrimaryAction = action.accent && !action.disabled;
  const isHandlingRef = useRef(false);

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (isHandlingRef.current) {
      return;
    }
    isHandlingRef.current = true;
    try {
      propsOnClick?.(e);
      if (e.defaultPrevented) {
        return;
      }
      action.action?.();
    } finally {
      queueMicrotask(() => {
        isHandlingRef.current = false;
      });
    }
  }, [action, propsOnClick]);
  return (
    <button
      ref={ref}
      {...props}
      type={props.type ?? "button"}
      className={cn(
        "flex min-h-[52px] min-w-[58px] flex-col items-center justify-center gap-1 rounded-md border p-1 transition-all",
        action.active
          ? "border-primary/20 bg-primary/10 text-primary shadow-inner"
          : isPrimaryAction
            ? "border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
            : "border-transparent text-foreground hover:border-border/50 hover:bg-muted/80",
        previewPending && action.active && "animate-pulse shadow-[0_0_0_1px_rgba(99,102,241,0.35)]",
        action.disabled && "pointer-events-none cursor-not-allowed opacity-40",
        props.className,
      )}
      disabled={action.disabled}
      onClick={handleClick}
    >
      <span
        className={cn(
          "flex flex-col items-center",
          isPrimaryAction
            ? action.iconColor ?? "text-primary-foreground"
            : action.active
              ? "text-primary"
              : action.iconColor ?? "text-muted-foreground",
        )}
      >
        {action.icon}
      </span>
      <span
        className={cn(
          "text-[0.62rem] font-medium leading-none text-center",
          isPrimaryAction
            ? "text-primary-foreground"
            : action.active
              ? "text-primary"
              : "text-foreground",
        )}
      >
        {action.label}
      </span>
    </button>
  );
});
RibbonActionTrigger.displayName = "RibbonActionTrigger";

function ribbonGroupToneClass(tone: RibbonGroup["tone"] | undefined): string {
  switch (tone) {
    case "authoring":
      return "border-emerald-500/30 bg-emerald-500/10";
    case "compose":
      return "border-violet-500/30 bg-violet-500/10";
    case "compute":
      return "border-primary/40 bg-primary/10";
    case "selection":
      return "border-amber-500/30 bg-amber-500/10";
    case "sync":
      return "border-cyan-500/30 bg-cyan-500/10";
    case "neutral":
      return "border-border/40 bg-muted/30";
    default:
      return "border-border/40 bg-muted/30";
  }
}

/* ── Component ──────────────────────────────────── */

export default function RibbonBar(props: RibbonBarProps) {
  const sessionId = useSessionRuntimeStore((s) => s.session?.session_id ?? null);
  const currentStage = useWorkspaceStore((s) => s.currentStage);
  const setCurrentStage = useWorkspaceStore((s) => s.setCurrentStage);
  const activeCoreTab = useWorkspaceStore((s) => s.activeCoreTab);
  const setActiveCoreTab = useWorkspaceStore((s) => s.setActiveCoreTab);
  const activeContextualTab = useWorkspaceStore((s) => s.activeContextualTab);
  const setActiveContextualTab = useWorkspaceStore((s) => s.setActiveContextualTab);
  const {
    ribbon: workspaceRibbon,
    loading: workspaceRibbonLoading,
    replaceRibbon: replaceWorkspaceRibbon,
  } = useWorkspaceRibbon({
    enabled: true,
    sessionKey: sessionId,
  });
  const workspaceRibbonHydratingRef = useRef(false);
  const lastPersistedWorkspaceRibbonRef = useRef<string | null>(null);
  const builderEnabled = useGeometryBuilderStore((s) => s.builderMode.enabled);
  const builderDirtyGeometry = useGeometryBuilderStore(
    (s) => s.dirty.geometryDraftDirty || s.dirty.geometryRealizationDirty,
  );
  const builderDirtyMesh = useGeometryBuilderStore((s) => s.dirty.meshDirty);
  const builderHasRealization = useGeometryBuilderStore((s) => s.geometryRealization !== null);
  const builderSelectedPrimitiveId = useGeometryBuilderStore((s) =>
    s.builderSelection.type === "primitive" ? s.builderSelection.id : null,
  );
  const workspaceStage = props.workspaceMode ?? currentStage;
  useEffect(() => {
    if (!sessionId) {
      lastPersistedWorkspaceRibbonRef.current = null;
      workspaceRibbonHydratingRef.current = false;
      return;
    }
    if (!workspaceRibbon) {
      return;
    }
    const nextIdentity = workspaceRibbonIdentity(workspaceRibbon);
    lastPersistedWorkspaceRibbonRef.current = nextIdentity;
    const currentIdentity = workspaceRibbonIdentity({
      workspace_mode: workspaceStage,
      active_core_tab: activeCoreTab,
      active_contextual_tab: activeContextualTab,
    });
    if (currentIdentity === nextIdentity) {
      return;
    }
    workspaceRibbonHydratingRef.current = true;
    setCurrentStage(normalizeWorkspaceMode(workspaceRibbon.workspace_mode));
    setActiveCoreTab(workspaceRibbon.active_core_tab);
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
    setCurrentStage,
    workspaceRibbon,
    workspaceStage,
  ]);

  useEffect(() => {
    if (!sessionId || workspaceRibbonLoading || workspaceRibbonHydratingRef.current) {
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
    workspaceRibbonLoading,
    workspaceStage,
  ]);

  const visibleTabs = useMemo(() => tabsForMode(workspaceStage), [workspaceStage]);
  const defaultTab = defaultTabForMode(workspaceStage);
  const contextualTabs = useMemo(
    () => contextualTabsForSelection(props),
    // Only the fields contextualTabsForSelection actually reads:
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const groups = useMemo(() => {
    const ctx = buildContext(props, {
      builderEnabled,
      builderDirtyGeometry,
      builderDirtyMesh,
      builderHasRealization,
      builderSelectedPrimitiveId,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab,
    activeContextualTabId,
    props.workspaceMode,
    props.viewMode,
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
    props.antennaSources,
    props.selectedAntennaName,
    props.canSyncScriptBuilder,
    props.scriptSyncBusy,
    props.selectedObjectId,
    props.onAddGeometryPreset,
    props.onStudyAddPrimitive,
    props.onStudyAddMacro,
    props.onStudyDuplicateSelected,
    props.onStudyToggleSelectedEnabled,
    props.onObjectAddInteraction,
    props.onAssignMagnetizationPreset,
    props.onSetTextureTransformMode,
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
    builderSelectedPrimitiveId,
  ]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col w-full bg-card/10 border-b border-border/15 backdrop-blur-xl shrink-0 z-30">
        {/* ── Tab row ── */}
        <div className="flex px-3 pt-2 gap-1 border-b border-border/10">
          {visibleTabs.map((tab) => {
            const isActive = String(tab) === String(activeTab);
            return (
            <button
              key={tab}
              onClick={() => setActiveCoreTab(tab)}
              className={cn(
                "px-5 py-2.5 min-w-[80px] text-[0.80rem] transition-all duration-300 rounded-t-lg font-sans cursor-pointer",
                isActive 
                  ? "text-foreground font-medium tracking-wide relative"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/20"
              )}
              style={isActive ? {
                textShadow: '0 0 8px rgba(255,255,255,0.2)',
              } : undefined}
            >
              {/* Very subtle gradient background */}
              {isActive && (
                <span 
                  className="absolute inset-0 rounded-t-lg"
                  style={{
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.10) 0%, rgba(139,92,246,0.06) 100%)',
                    boxShadow: 'inset 0 0 10px rgba(255,255,255,0.04), 0 0 8px rgba(99,102,241,0.08)',
                  }}
                />
              )}
              <span className="relative z-10">{tab}</span>
            </button>
            );
          })}
          {contextualTabs.length > 0 ? (
            <div className="ml-auto mb-2 flex items-center gap-1.5 pl-4">
              <span className="text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                Context
              </span>
              {contextualTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    "rounded-md border px-2 py-1 text-[0.63rem] font-semibold tracking-wide transition-colors",
                    activeContextualTabId === tab.id
                      ? "border-primary/30 bg-primary/12 text-primary"
                      : "border-border/30 bg-background/30 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                  onClick={() => setActiveContextualTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}
          {activeTab === "Mesh" && (
            <div className={cn(
              "mb-2 flex items-center gap-2 pl-4",
              contextualTabs.length > 0 ? "border-l border-border/20 ml-1" : "ml-auto",
            )}>
              <span className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                Mesh Status
              </span>
              <span
                className={cn(
                  "rounded-md border px-2 py-1 text-[0.68rem] font-medium",
                  props.meshGenerating
                    ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
                    : props.meshConfigDirty
                      ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                      : "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
                )}
              >
                {props.meshGenerating
                  ? "Building"
                  : props.meshConfigDirty
                    ? "Out of date"
                    : "Up to date"}
              </span>
              <span className="text-[0.7rem] text-muted-foreground">
                {props.meshGenerating
                  ? "The build modal is streaming live meshing progress."
                  : props.meshConfigDirty
                    ? "Viewport shows the last built mesh until you rebuild."
                    : "Viewport reflects the latest built mesh."}
              </span>
            </div>
          )}
        </div>

        {/* ── Actions row ── */}
        <div className="flex items-stretch overflow-x-auto scrollbar-none py-2 px-2 gap-1 min-h-[88px]">
          {groups.filter((g) => g.actions.some((a) => !a.hidden)).map((group, gi) => (
            <div key={group.id} className="flex items-stretch shrink-0">
              {gi > 0 && <div className="w-px bg-border/20 mx-2 self-stretch my-3" />}
              <div
                className={cn(
                  "flex min-h-[74px] flex-col justify-between items-center rounded-lg border px-2 py-1.5 shrink-0",
                  ribbonGroupToneClass(group.tone),
                )}
              >
                <div className="flex items-center gap-1">
                  {group.actions.filter((a) => !a.hidden).map((action) =>
                    action.menuItems && action.menuItems.length > 0 ? (
                      <DropdownMenu.Root key={action.id}>
                        <DropdownMenu.Trigger asChild>
                          <RibbonActionTrigger action={action} previewPending={props.previewPending} />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            className="z-[100] min-w-[280px] rounded-md border border-border/50 bg-popover/95 p-1 text-popover-foreground shadow-md backdrop-blur-xl animate-in fade-in-80 slide-in-from-top-1"
                            sideOffset={8}
                            align="start"
                          >
                            {action.menuItems.filter((it) => !it.hidden).map((item) =>
                              item.separator ? (
                                <DropdownMenu.Separator
                                  key={item.id}
                                  className="my-1 h-px bg-border/50"
                                />
                              ) : (
                                <DropdownMenu.Item
                                  key={item.id}
                                  className={cn(
                                    "relative flex cursor-default select-none items-start gap-2 rounded-sm px-2 py-2 text-xs outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted data-[highlighted]:text-foreground",
                                    item.active && "bg-primary/10 text-primary",
                                  )}
                                  disabled={item.disabled}
                                  onSelect={() => item.action?.()}
                                >
                                  <span className="mt-0.5 flex h-4 w-4 items-center justify-center text-muted-foreground opacity-80">
                                    {item.icon}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate font-medium">{item.label}</span>
                                    {item.description ? (
                                      <span className="block truncate text-[0.68rem] text-muted-foreground">
                                        {item.description}
                                      </span>
                                    ) : null}
                                  </span>
                                </DropdownMenu.Item>
                              ),
                            )}
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    ) : action.tooltip ? (
                      <Tooltip key={action.id}>
                        <TooltipTrigger asChild>
                          <RibbonActionTrigger action={action} previewPending={props.previewPending} />
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs border border-border shadow-xl">
                          <span className="font-semibold">{action.tooltip}</span>
                          {action.shortcut && (
                            <kbd className="opacity-80 font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded ml-2 border border-border">{action.shortcut}</kbd>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <RibbonActionTrigger
                        key={action.id}
                        action={action}
                        previewPending={props.previewPending}
                      />
                    ),
                  )}
                </div>
                <div className="mt-1 w-full border-t border-border/20 pt-1 text-center">
                  <span className="block text-[0.6rem] font-semibold text-muted-foreground opacity-85">
                    {group.title}
                  </span>
                  {group.subtitle ? (
                    <span className="block text-[0.54rem] font-medium text-muted-foreground/75">
                      {group.subtitle}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

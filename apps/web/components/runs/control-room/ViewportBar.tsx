"use client";

import { memo, useCallback, useEffect, useMemo, useReducer } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bug,
  Camera,
  Eye,
  Focus,
  Hand,
  Info,
  Layers3,
  Magnet,
  Maximize2,
  Monitor,
  Move,
  Palette,
  RotateCw,
  ScanLine,
  Settings2,
  Sparkles,
  Zap,
} from "lucide-react";

import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { useLiveStatus } from "@/src/hooks/resources/useLiveStatus";
import type { FieldComponent } from "@/src/api/types";
import { UnifiedViewportBar, useViewport3DController } from "@/features/viewport-unified";
import { useUnifiedDisplayControls } from "@/features/viewport-unified/hooks/useUnifiedDisplayControls";
import {
  mapViewport3DFdmPatchToLegacySettingsPatch,
} from "@/features/viewport-unified/model/viewport3dAdapters";
import {
  DEFAULT_FEM_VIEWPORT_LAYER_STATE,
  type UnifiedRenderState,
} from "@/features/viewport-unified/model/unifiedViewportTypes";
import {
  createViewport3DToolbarState,
  viewport3dToolbarReducer,
} from "@/features/viewport-unified/model/viewport3dToolbarReducer";
import type {
  Viewport3DFdmModulePatch,
} from "@/features/viewport-unified/model/viewport3dContracts";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import { defaultMeshEntityViewState } from "@/lib/session/types";

import type { RenderMode } from "../../preview/FemMeshView3D";
import type { VectorComponent } from "./shared";
import { useCommand, useModel, useTransport, useViewport } from "./context-hooks";

function toUnifiedVectorComponent(
  component: string,
): UnifiedRenderState["vectorComponent"] {
  if (component === "x" || component === "y" || component === "z" || component === "3D") {
    return component;
  }
  return "|v|";
}

function fromUnifiedVectorComponent(
  component: UnifiedRenderState["vectorComponent"],
): "3D" | VectorComponent {
  if (component === "3D") {
    return "3D";
  }
  if (component === "x" || component === "y" || component === "z") {
    return component;
  }
  return "magnitude";
}

function toUnifiedMeshRenderMode(
  mode: RenderMode,
): NonNullable<UnifiedRenderState["meshRenderMode"]> {
  if (mode === "surface+edges") {
    return "solid+wireframe";
  }
  if (mode === "wireframe" || mode === "points") {
    return mode;
  }
  return "solid";
}

function fromUnifiedMeshRenderMode(
  mode: UnifiedRenderState["meshRenderMode"],
): RenderMode {
  if (mode === "wireframe" || mode === "points") {
    return mode;
  }
  if (mode === "solid+wireframe") {
    return "surface+edges";
  }
  return "surface";
}

function toViewportFieldComponent(component: string): FieldComponent | null {
  if (
    component === "full" ||
    component === "magnitude" ||
    component === "x" ||
    component === "y" ||
    component === "z"
  ) {
    return component;
  }
  if (component === "3D" || component === "|v|") {
    return "magnitude";
  }
  return null;
}

type GeometryTool = "camera" | "select" | "move" | "rotate" | "scale";

const ROW_B_BUTTON_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 text-[0.68rem] font-medium text-muted-foreground transition-colors hover:border-border/45 hover:bg-muted/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35";
const ROW_B_BUTTON_ACTIVE_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/35 bg-primary/12 px-2 text-[0.68rem] font-semibold text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-35";
const ROW_B_GROUP_TITLE_CLASS =
  "mr-1 text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70";
const ROW_B_HINT_CLASS = "text-[0.66rem] text-muted-foreground";
const ROW_B_GROUP_CLASS =
  "flex min-h-8 flex-wrap items-center gap-0.5 border-r border-border/25 pr-2 last:border-r-0";
const ROW_B_SHORTCUT_CLASS =
  "rounded border border-border/35 bg-background/55 px-1 py-0.5 text-[0.55rem] font-semibold uppercase leading-none text-muted-foreground/80";
const ROW_B_ICON_CLASS = "h-3.5 w-3.5 shrink-0 opacity-85";

interface ToolbarActionButtonProps {
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  pressed?: boolean;
  onClick: () => void;
}

function ToolbarActionButton({
  label,
  icon: Icon,
  shortcut,
  active = false,
  disabled = false,
  title,
  pressed,
  onClick,
}: ToolbarActionButtonProps) {
  return (
    <button
      type="button"
      className={active ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
    >
      <Icon className={ROW_B_ICON_CLASS} />
      <span>{label}</span>
      {shortcut ? <span className={ROW_B_SHORTCUT_CLASS}>{shortcut}</span> : null}
    </button>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

export const ViewportBar = memo(function ViewportBar() {
  const command = useCommand();
  const viewport = useViewport();
  const model = useModel();
  const transport = useTransport();
  const { status } = useLiveStatus({
    enabled: FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar,
  });

  const builderEnabled = useGeometryBuilderStore((state) => state.builderMode.enabled);
  const builderTool = useGeometryBuilderStore((state) => state.viewportTool);
  const setBuilderTool = useGeometryBuilderStore((state) => state.setViewportTool);
  const builderSnapSettings = useGeometryBuilderStore((state) => state.snapSettings);
  const toggleBuilderSnap = useGeometryBuilderStore((state) => state.toggleSnap);
  const requestBuilderFocusSelected = useGeometryBuilderStore((state) => state.requestFocusSelected);
  const requestBuilderFrameAll = useGeometryBuilderStore((state) => state.requestFrameAll);
  const rightInspectorOpen = useWorkspaceStore((state) => state.rightInspectorOpen);
  const setRightInspectorOpen = useWorkspaceStore((state) => state.setRightInspectorOpen);
  const rightInspectorTab = useWorkspaceStore((state) => state.rightInspectorTab);
  const setRightInspectorTab = useWorkspaceStore((state) => state.setRightInspectorTab);

  const [toolbarState, dispatchToolbar] = useReducer(
    viewport3dToolbarReducer,
    undefined,
    () =>
      createViewport3DToolbarState({
        rowB: {
          interactionMode: "camera",
          projection: "perspective",
          navProfile: "trackball",
        },
      }),
  );

  const displayControls = useUnifiedDisplayControls(viewport.patchDisplay);

  const renderState = useMemo<UnifiedRenderState>(() => ({
    selectedLayer: viewport.requestedPreviewLayer ?? viewport.sliceIndex,
    allLayersVisible: viewport.requestedPreviewAllLayers,
    vectorComponent:
      viewport.effectiveViewMode === "3D" && viewport.component === "magnitude"
        ? "3D"
        : toUnifiedVectorComponent(viewport.component),
    colorScale: "viridis",
    autoScale: viewport.requestedPreviewAutoScale,
    maxPoints: viewport.requestedPreviewMaxPoints,
    everyN: viewport.requestedPreviewEveryN,
    meshRenderMode: toUnifiedMeshRenderMode(model.meshRenderMode),
    meshOpacity: model.meshOpacity,
    clipEnabled: model.meshClipEnabled,
    clipAxis: model.meshClipAxis,
    clipPosition: model.meshClipPos,
    femLayers: model.femViewportLayers,
  }), [
    model.meshClipAxis,
    model.meshClipEnabled,
    model.meshClipPos,
    model.meshOpacity,
    model.meshRenderMode,
    model.femViewportLayers,
    status,
    viewport.component,
    viewport.effectiveViewMode,
    viewport.previewControlsActive,
    viewport.requestedPreviewAllLayers,
    viewport.requestedPreviewAutoScale,
    viewport.requestedPreviewComponent,
    viewport.requestedPreviewEveryN,
    viewport.requestedPreviewLayer,
    viewport.requestedPreviewMaxPoints,
    viewport.sliceIndex,
  ]);

  const onRenderStateChange = useCallback((next: UnifiedRenderState) => {
    if (next.vectorComponent !== renderState.vectorComponent) {
      const nextComponent = fromUnifiedVectorComponent(next.vectorComponent);
      viewport.setComponent(nextComponent === "3D" ? "magnitude" : nextComponent);
      void displayControls.setComponent(nextComponent);
    }

    if (next.selectedLayer !== renderState.selectedLayer) {
      viewport.setSliceIndex(next.selectedLayer);
      void displayControls.setLayer(next.selectedLayer);
    }

    if (next.allLayersVisible !== renderState.allLayersVisible) {
      void displayControls.setAllLayers(next.allLayersVisible);
    }

    if (next.everyN !== renderState.everyN) {
      void displayControls.setEveryN(next.everyN);
    }

    if (next.colorScale !== renderState.colorScale) {
      void displayControls.setColormap(next.colorScale);
    }

    if (next.autoScale !== renderState.autoScale) {
      void displayControls.setAutoScale(next.autoScale);
    }

    if (next.meshRenderMode !== renderState.meshRenderMode) {
      const nextRenderMode = fromUnifiedMeshRenderMode(next.meshRenderMode);
      model.setMeshRenderMode(nextRenderMode);
      if (model.meshParts.length > 0) {
        model.setMeshEntityViewState((previous) => {
          let changed = false;
          const updated = { ...previous };
          for (const part of model.meshParts) {
            const current = updated[part.id] ?? defaultMeshEntityViewState(part);
            if (current.renderMode === nextRenderMode) {
              continue;
            }
            updated[part.id] = { ...current, renderMode: nextRenderMode };
            changed = true;
          }
          return changed ? updated : previous;
        });
      }
    }

    if (next.meshOpacity !== renderState.meshOpacity && typeof next.meshOpacity === "number") {
      model.setMeshOpacity(next.meshOpacity);
    }

    if (next.clipEnabled !== renderState.clipEnabled) {
      model.setMeshClipEnabled(Boolean(next.clipEnabled));
    }

    if (next.clipAxis !== renderState.clipAxis && next.clipAxis) {
      model.setMeshClipAxis(next.clipAxis);
    }

    if (next.clipPosition !== renderState.clipPosition && typeof next.clipPosition === "number") {
      model.setMeshClipPos(next.clipPosition);
    }

    const currentLayers = renderState.femLayers ?? DEFAULT_FEM_VIEWPORT_LAYER_STATE;
    const nextLayers = next.femLayers ?? DEFAULT_FEM_VIEWPORT_LAYER_STATE;
    if (
      nextLayers.showPrimitives !== currentLayers.showPrimitives ||
      nextLayers.showMesh !== currentLayers.showMesh ||
      nextLayers.showQuantity !== currentLayers.showQuantity
    ) {
      model.setFemViewportLayers(nextLayers);
    }
  }, [displayControls, model, renderState, viewport]);

  const quantityOptions = useMemo(
    () =>
      viewport.previewQuantityOptions.map((option) => ({
        id: option.value,
        label: option.label,
        available: !option.disabled,
      })),
    [viewport.previewQuantityOptions],
  );

  const legacyFdmVectorsEnabled = status?.display.vector_glyphs ?? true;
  const viewport3DController = useViewport3DController({
    capabilities: status?.capabilities ?? null,
    authoringEnabled: builderEnabled,
    diagnosticsEnabled: FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging,
    renderState,
    resources: {
      statusResources: status?.resources ?? null,
      quantityId: viewport.requestedPreviewQuantity ?? null,
      component: toViewportFieldComponent(renderState.vectorComponent),
      selection: {
        objectId: model.viewportSelectedObjectId,
        partId: model.selectedEntityId,
      },
      clip: {
        enabled: Boolean(renderState.clipEnabled),
        axis: renderState.clipAxis ?? "z",
        position:
          typeof renderState.clipPosition === "number" ? renderState.clipPosition : 50,
        invert: model.meshClipFlip,
      },
      topologyFallbackRevision: model.femTopologyKey,
      femMeshFieldRevision: model.femMeshData?.fieldRevision,
      dataPlaneFieldRevision: transport.fieldDataRevision,
      selectedVectorCount: transport.selectedVectors?.length ?? 0,
    },
    toolbar: {
      clipFlip: model.meshClipFlip,
      interactionMode: toolbarState.rowB.interactionMode,
      snapEnabled: toolbarState.rowB.snapEnabled,
      objectViewMode: toolbarState.rowB.objectView,
      vectorsVisible: legacyFdmVectorsEnabled,
      legendVisible: model.viewportLegendVisible,
      partExplorerVisible: toolbarState.rowB.partExplorerVisible,
      projection: toolbarState.rowB.projection,
      navProfile: toolbarState.rowB.navProfile,
      popovers: toolbarState.popovers,
    },
    model: {
      discretization: command.isFemBackend ? "fem" : "fdm",
      worldExtent: model.worldExtent,
      worldCenter: model.worldCenter,
      selectedEntityFallbackId: model.selectedEntityId,
      focusedEntityId: model.focusedEntityId,
      selectedSidebarNodeId: model.selectedSidebarNodeId,
      loading: viewport.previewBusy,
      message: viewport.previewMessage,
      error: command.error,
      pendingMeshBuild: model.meshConfigDirty,
      sourceKind: status ? "live" : "none",
      fdmSettings: model.fdmVisualizationSettings,
      fdmVectorsVisible: legacyFdmVectorsEnabled,
    },
  });
  const capabilities = viewport3DController.capabilities;
  const viewportToolbarState = viewport3DController.toolbarState;
  const viewport3DControlReasons = useMemo<Partial<Record<string, string | null>>>(
    () => ({ ...viewport3DController.controlReasons }),
    [viewport3DController.controlReasons],
  );
  const viewport3DModel = viewport3DController.model;
  const fdmModule = viewport3DModel.fdm;

  const supports3D = capabilities.preview3d.enabled;
  const supportsTopology = capabilities.explicitTopology.enabled;
  const supportsStructuredGrid = capabilities.structuredGrid.enabled;
  const supportsAuthoring = builderEnabled;
  const authoringUnavailableReason = capabilities.authoringPrimitives.reason
    ?? (supportsTopology
      ? "Enable Geometry Authoring mode to use transform tools."
      : "Requires explicit_topology capability.");
  const partExplorerOpen = rightInspectorOpen && rightInspectorTab === "selected-submeshes";

  const vectorsEnabled = supportsTopology
    ? model.meshShowArrows
    : (fdmModule?.vectorsVisible ?? legacyFdmVectorsEnabled);
  const activeTool: GeometryTool = supportsAuthoring
    ? builderTool
    : (toolbarState.rowB.interactionMode as GeometryTool);

  const setTool = useCallback((tool: GeometryTool) => {
    dispatchToolbar({ type: "setInteractionMode", value: tool });
    if (supportsAuthoring) {
      setBuilderTool(tool);
      return;
    }
  }, [setBuilderTool, supportsAuthoring]);

  const toggleVectors = useCallback(() => {
    const next = !vectorsEnabled;
    dispatchToolbar({ type: "setVectorsVisible", value: next });
    if (supportsTopology) {
      model.setMeshShowArrows(next);
      return;
    }
    void displayControls.setVectorGlyphs(next);
  }, [displayControls, model, supportsTopology, vectorsEnabled]);

  const patchFdmSettings = useCallback(
    (delta: Viewport3DFdmModulePatch) => {
      const legacyDelta = mapViewport3DFdmPatchToLegacySettingsPatch(delta);
      if (Object.keys(legacyDelta).length === 0) {
        return;
      }
      model.setFdmVisualizationSettings((previous) => ({ ...previous, ...legacyDelta }));
    },
    [model],
  );
  const fdmRenderMode = fdmModule?.renderMode ?? model.fdmVisualizationSettings.render_mode;
  const fdmSampling = fdmModule?.sampling ?? model.fdmVisualizationSettings.sampling;
  const fdmBrightness = fdmModule?.brightness ?? model.fdmVisualizationSettings.brightness;
  const fdmVoxelOpacity = fdmModule?.voxelOpacity ?? model.fdmVisualizationSettings.voxel_opacity;
  const fdmVoxelGap = fdmModule?.voxelGap ?? model.fdmVisualizationSettings.voxel_gap;
  const fdmVoxelThreshold =
    fdmModule?.voxelThreshold ?? model.fdmVisualizationSettings.voxel_threshold;
  const fdmTopographyEnabled =
    fdmModule?.topography.enabled ?? model.fdmVisualizationSettings.topo_enabled;
  const fdmTopographyAxis =
    fdmModule?.topography.component ?? model.fdmVisualizationSettings.topo_component;
  const fdmTopographyAmplitude =
    fdmModule?.topography.amplitude ?? model.fdmVisualizationSettings.topo_multiplier;

  const patchBuilderSnapSettings = useCallback(
    (
      delta: Partial<{
        enabled: boolean;
        translateStepMeters: number;
        rotateStepDeg: number;
        scaleStep: number;
      }>,
    ) => {
      useGeometryBuilderStore.setState((previous) => ({
        snapSettings: {
          ...previous.snapSettings,
          ...delta,
        },
      }));
    },
    [],
  );

  const focusSelected = useCallback(() => {
    if (supportsAuthoring) {
      requestBuilderFocusSelected();
      setBuilderTool("camera");
      return;
    }
    if (model.viewportSelectedObjectId) {
      model.requestFocusObject(model.viewportSelectedObjectId);
    }
  }, [
    model,
    requestBuilderFocusSelected,
    setBuilderTool,
    supportsAuthoring,
  ]);

  const frameAll = useCallback(() => {
    if (!supportsAuthoring) {
      return;
    }
    requestBuilderFrameAll();
    setBuilderTool("camera");
  }, [requestBuilderFrameAll, setBuilderTool, supportsAuthoring]);

  const togglePartExplorer = useCallback(() => {
    dispatchToolbar({ type: "setPartExplorerVisible", value: !partExplorerOpen });
    if (partExplorerOpen) {
      setRightInspectorTab("properties");
      return;
    }
    setRightInspectorOpen(true);
    setRightInspectorTab("selected-submeshes");
  }, [partExplorerOpen, setRightInspectorOpen, setRightInspectorTab]);

  const vectorsSettingsOpen = toolbarState.popovers.vectors;
  const colorSettingsOpen = toolbarState.popovers.color;
  const displaySettingsOpen = toolbarState.popovers.display;
  const topographySettingsOpen = toolbarState.popovers.topography;
  const snapSettingsOpen = toolbarState.popovers.snapSettings;
  const cameraSettingsOpen = toolbarState.popovers.camera;
  const panelsOpen = toolbarState.popovers.panels;
  const infoOpen = toolbarState.popovers.info;
  const rotationDebugOpen = toolbarState.popovers.rotationDebug;
  const liveRenderDebugOpen = toolbarState.popovers.liveRenderDebug;
  const applyCameraPreset = useCallback((preset: "reset" | "front" | "top" | "right" | "iso") => {
    if (preset === "reset") {
      frameAll();
    }
  }, [frameAll]);

  const canFocusSelected = supportsAuthoring || Boolean(model.viewportSelectedObjectId);
  const canFrameAll = supportsAuthoring;
  const showViewportBar = FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar;
  const unifiedToolbarEnabled =
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableUnifiedViewportToolbar;

  useEffect(() => {
    if (!unifiedToolbarEnabled || supportsAuthoring) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const key = event.key.toUpperCase();
      if (event.shiftKey && key === "F") {
        if (canFrameAll) {
          event.preventDefault();
          frameAll();
        }
        return;
      }
      if (event.shiftKey) {
        return;
      }
      if (key === "Q" && supports3D) {
        event.preventDefault();
        setTool("camera");
        return;
      }
      if (key === "F" && canFocusSelected) {
        event.preventDefault();
        focusSelected();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    canFocusSelected,
    canFrameAll,
    focusSelected,
    frameAll,
    setTool,
    supports3D,
    supportsAuthoring,
    unifiedToolbarEnabled,
  ]);

  if (!showViewportBar) {
    return null;
  }

  if (!unifiedToolbarEnabled) {
    return (
      <UnifiedViewportBar
        capabilities={capabilities}
        renderState={renderState}
        onRenderStateChange={onRenderStateChange}
        gridDepth={viewport.solverGrid[2] > 0 ? viewport.solverGrid[2] : undefined}
        disabled={viewport.previewBusy}
        controlStates={viewportToolbarState.controlStates}
        controlReasons={viewport3DControlReasons}
      />
    );
  }

  return (
    <div className="border-b border-border/20 bg-card/10 shrink-0">
      <UnifiedViewportBar
        capabilities={capabilities}
        renderState={renderState}
        onRenderStateChange={onRenderStateChange}
        gridDepth={viewport.solverGrid[2] > 0 ? viewport.solverGrid[2] : undefined}
        disabled={viewport.previewBusy}
        quantityId={viewport.requestedPreviewQuantity}
        quantityOptions={quantityOptions}
        quantityStatus={viewport.requestedPreviewQuantityDataStatus}
        onQuantityChange={viewport.requestDisplayQuantity}
        clipFlip={model.meshClipFlip}
        onClipFlipChange={model.setMeshClipFlip}
        controlStates={viewportToolbarState.controlStates}
        controlReasons={viewport3DControlReasons}
      />

      <div
        className="border-t border-border/20 bg-background/70 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]"
        role="toolbar"
        aria-label="Viewport tools"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <div className={ROW_B_GROUP_CLASS}>
            <span className={ROW_B_GROUP_TITLE_CLASS}>Camera</span>
            <ToolbarActionButton
              label="Camera"
              shortcut="Q"
              icon={Camera}
              active={activeTool === "camera"}
              disabled={!supports3D}
              title="Camera navigation mode (Q)"
              pressed={activeTool === "camera"}
              onClick={() => setTool("camera")}
            />
            <ToolbarActionButton
              label="Focus"
              shortcut="F"
              icon={Focus}
              disabled={!canFocusSelected}
              title={canFocusSelected ? "Focus selected (F)" : "Requires selected object or authoring_primitives."}
              onClick={() => focusSelected()}
            />
            <ToolbarActionButton
              label="Frame All"
              shortcut="Shift+F"
              icon={ScanLine}
              disabled={!canFrameAll}
              title={canFrameAll ? "Frame all (Shift+F)." : authoringUnavailableReason}
              onClick={() => frameAll()}
            />
          </div>

          <div className={ROW_B_GROUP_CLASS}>
            <span className={ROW_B_GROUP_TITLE_CLASS}>Transform</span>
            {(
              [
                {
                  tool: "select",
                  label: "Select",
                  shortcut: "S",
                  icon: Hand,
                  disabled: !supportsAuthoring,
                  title: supportsAuthoring ? "Selection mode (S)." : authoringUnavailableReason,
                },
                {
                  tool: "move",
                  label: "Move",
                  shortcut: "W",
                  icon: Move,
                  disabled: !supportsAuthoring,
                  title: supportsAuthoring ? "Move tool (W)." : authoringUnavailableReason,
                },
                {
                  tool: "rotate",
                  label: "Rotate",
                  shortcut: "E",
                  icon: RotateCw,
                  disabled: !supportsAuthoring,
                  title: supportsAuthoring ? "Rotate tool (E)." : authoringUnavailableReason,
                },
                {
                  tool: "scale",
                  label: "Scale",
                  shortcut: "R",
                  icon: Maximize2,
                  disabled: !supportsAuthoring,
                  title: supportsAuthoring ? "Scale tool (R)." : authoringUnavailableReason,
                },
              ] as Array<{
                tool: GeometryTool;
                label: string;
                shortcut: string;
                icon: LucideIcon;
                disabled: boolean;
                title: string;
              }>
            ).map((entry) => (
              <ToolbarActionButton
                key={entry.tool}
                label={entry.label}
                shortcut={entry.shortcut}
                icon={entry.icon}
                active={activeTool === entry.tool}
                disabled={entry.disabled}
                title={entry.title}
                pressed={activeTool === entry.tool}
                onClick={() => setTool(entry.tool)}
              />
            ))}
            <ToolbarActionButton
              label="Snap"
              shortcut="G"
              icon={Magnet}
              active={builderSnapSettings.enabled}
              disabled={!supportsAuthoring}
              title={supportsAuthoring ? "Toggle transform snap (G)." : authoringUnavailableReason}
              pressed={builderSnapSettings.enabled}
              onClick={() => {
                const next = !builderSnapSettings.enabled;
                toggleBuilderSnap();
                dispatchToolbar({ type: "setSnapEnabled", value: next });
              }}
            />
            <ToolbarActionButton
              label="Snap Settings"
              icon={Settings2}
              active={snapSettingsOpen}
              disabled={!supportsAuthoring}
              title={supportsAuthoring ? "Open snap settings." : authoringUnavailableReason}
              pressed={snapSettingsOpen}
              onClick={() => dispatchToolbar({ type: "togglePopover", key: "snapSettings" })}
            />
          </div>

          <div className={ROW_B_GROUP_CLASS}>
            <span className={ROW_B_GROUP_TITLE_CLASS}>View</span>
            <ToolbarActionButton
              label="Context"
              icon={Layers3}
              active={model.objectViewMode === "context"}
              title="Show context objects"
              pressed={model.objectViewMode === "context"}
              onClick={() => {
                model.setObjectViewMode("context");
                dispatchToolbar({ type: "setObjectView", value: "context" });
              }}
            />
            <ToolbarActionButton
              label="Isolate"
              icon={Eye}
              active={model.objectViewMode === "isolate"}
              title="Isolate selected object"
              pressed={model.objectViewMode === "isolate"}
              onClick={() => {
                model.setObjectViewMode("isolate");
                dispatchToolbar({ type: "setObjectView", value: "isolate" });
              }}
            />
            <ToolbarActionButton
              label={vectorsEnabled ? "Vectors On" : "Vectors Off"}
              icon={Zap}
              active={vectorsEnabled}
              disabled={!supports3D}
              title={supports3D ? "Toggle vectors/glyph layer" : "Requires preview_3d capability."}
              pressed={vectorsEnabled}
              onClick={() => toggleVectors()}
            />
            <ToolbarActionButton
              label="Vector Settings"
              icon={Settings2}
              active={vectorsSettingsOpen}
              disabled={!supports3D}
              title={supports3D ? "Open vectors settings" : "Requires preview_3d capability."}
              pressed={vectorsSettingsOpen}
              onClick={() => dispatchToolbar({ type: "togglePopover", key: "vectors" })}
            />
            <ToolbarActionButton
              label="Color"
              icon={Palette}
              active={colorSettingsOpen}
              disabled={!supports3D}
              title={supports3D ? "Color popover: surface/arrow/voxel color modes." : "Requires preview_3d capability."}
              pressed={colorSettingsOpen}
              onClick={() => dispatchToolbar({ type: "togglePopover", key: "color" })}
            />
            <ToolbarActionButton
              label="Display"
              icon={Monitor}
              active={displaySettingsOpen}
              disabled={!supports3D}
              title={supports3D ? "Display popover: quality and visual profile controls." : "Requires preview_3d capability."}
              pressed={displaySettingsOpen}
              onClick={() => dispatchToolbar({ type: "togglePopover", key: "display" })}
            />
            <ToolbarActionButton
              label="Topography"
              icon={Sparkles}
              active={topographySettingsOpen}
              disabled={!supportsStructuredGrid}
              title={supportsStructuredGrid ? "Topography popover for structured-grid views." : "Requires structured_grid capability."}
              pressed={topographySettingsOpen}
              onClick={() => dispatchToolbar({ type: "togglePopover", key: "topography" })}
            />
            <ToolbarActionButton
              label="Camera"
              icon={Camera}
              active={cameraSettingsOpen}
              disabled={!canFrameAll}
              title={canFrameAll ? "Camera reset and framing controls." : authoringUnavailableReason}
              pressed={cameraSettingsOpen}
              onClick={() => dispatchToolbar({ type: "togglePopover", key: "camera" })}
            />
            <ToolbarActionButton
              label="Capture"
              icon={ScanLine}
              disabled={!supports3D}
              title={supports3D ? "Screenshot" : "Requires preview_3d capability."}
              onClick={() => viewport.handleCapture()}
            />
          </div>

          <div className={ROW_B_GROUP_CLASS}>
            <span className={ROW_B_GROUP_TITLE_CLASS}>Panels</span>
            <ToolbarActionButton
              label="Panels"
              icon={Layers3}
              active={panelsOpen}
              title="Panels popover: legend and part explorer."
              pressed={panelsOpen}
              onClick={() => dispatchToolbar({ type: "togglePopover", key: "panels" })}
            />
            <ToolbarActionButton
              label="Info"
              icon={Info}
              active={infoOpen}
              title="Scene and renderer info"
              pressed={infoOpen}
              onClick={() => dispatchToolbar({ type: "togglePopover", key: "info" })}
            />
            {capabilities.diagnostics.enabled ? (
              <>
                <ToolbarActionButton
                  label="Rotation Debug"
                  icon={Bug}
                  active={rotationDebugOpen}
                  title="Rotation debug popover"
                  pressed={rotationDebugOpen}
                  onClick={() => dispatchToolbar({ type: "togglePopover", key: "rotationDebug" })}
                />
                <ToolbarActionButton
                  label="Render Debug"
                  icon={Activity}
                  active={liveRenderDebugOpen}
                  title="Live render debug popover"
                  pressed={liveRenderDebugOpen}
                  onClick={() => dispatchToolbar({ type: "togglePopover", key: "liveRenderDebug" })}
                />
              </>
            ) : null}
          </div>
        </div>
      </div>

      {vectorsSettingsOpen ? (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-2 border-t border-border/20">
          <span className={ROW_B_GROUP_TITLE_CLASS}>Vectors</span>
          {supportsTopology ? (
            <>
              <label className={ROW_B_HINT_CLASS}>
                Density
                <select
                  className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
                  value={renderState.everyN}
                  onChange={(event) => {
                    const nextEveryN = Number(event.target.value);
                    void displayControls.setEveryN(nextEveryN);
                  }}
                >
                  {[1, 2, 4, 8, 12, 16, 24, 32].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Domain
                <select
                  className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
                  value={model.femVectorDomainFilter}
                  onChange={(event) =>
                    model.setFemVectorDomainFilter(
                      event.target.value as "auto" | "magnetic_only" | "full_domain" | "airbox_only",
                    )
                  }
                >
                  <option value="auto">auto</option>
                  <option value="magnetic_only">magnetic_only</option>
                  <option value="full_domain">full_domain</option>
                  <option value="airbox_only">airbox_only</option>
                </select>
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Ferromagnet
                <select
                  className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
                  value={model.femFerromagnetVisibilityMode}
                  onChange={(event) =>
                    model.setFemFerromagnetVisibilityMode(event.target.value as "hide" | "ghost")
                  }
                >
                  <option value="hide">hide</option>
                  <option value="ghost">ghost</option>
                </select>
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Alpha
                <input
                  type="range"
                  className="ml-1 w-20 accent-primary align-middle"
                  min={0}
                  max={1}
                  step={0.01}
                  value={model.femArrowAlpha}
                  onChange={(event) => model.setFemArrowAlpha(Number(event.target.value))}
                />
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Length
                <input
                  type="range"
                  className="ml-1 w-20 accent-primary align-middle"
                  min={0.2}
                  max={4}
                  step={0.05}
                  value={model.femArrowLengthScale}
                  onChange={(event) => model.setFemArrowLengthScale(Number(event.target.value))}
                />
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Width
                <input
                  type="range"
                  className="ml-1 w-20 accent-primary align-middle"
                  min={0.2}
                  max={4}
                  step={0.05}
                  value={model.femArrowThickness}
                  onChange={(event) => model.setFemArrowThickness(Number(event.target.value))}
                />
              </label>
            </>
          ) : (
            <>
              <label className={ROW_B_HINT_CLASS}>
                Render
                <select
                  className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
                  value={fdmRenderMode}
                  onChange={(event) =>
                    patchFdmSettings({
                      renderMode: event.target.value as "glyph" | "voxel",
                    })
                  }
                >
                  <option value="glyph">glyph</option>
                  <option value="voxel">voxel</option>
                </select>
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Sampling
                <select
                  className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
                  value={fdmSampling}
                  onChange={(event) =>
                    patchFdmSettings({
                      sampling: Number(event.target.value) as 1 | 2 | 4,
                    })
                  }
                >
                  <option value={1}>1x</option>
                  <option value={2}>2x</option>
                  <option value={4}>4x</option>
                </select>
              </label>
              <span className={ROW_B_HINT_CLASS}>
                Display/voxel/topography controls are available in dedicated popovers.
              </span>
            </>
          )}
        </div>
      ) : null}

      {colorSettingsOpen ? (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-2 border-t border-border/20">
          <span className={ROW_B_GROUP_TITLE_CLASS}>Color</span>
          {supportsTopology ? (
            <>
              <label className={ROW_B_HINT_CLASS}>
                Surface
                <select
                  className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
                  value={model.femColorField}
                  disabled
                  title="Per-part FEM surface color mapping is currently driven by mesh part state and can be mixed."
                >
                  <option value={model.femColorField}>{model.femColorField}</option>
                </select>
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Arrows
                <select
                  className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
                  value={model.femArrowColorMode}
                  onChange={(event) =>
                    model.setFemArrowColorMode(
                      event.target.value as "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome",
                    )
                  }
                >
                  <option value="orientation">orientation</option>
                  <option value="x">x</option>
                  <option value="y">y</option>
                  <option value="z">z</option>
                  <option value="magnitude">magnitude</option>
                  <option value="monochrome">monochrome</option>
                </select>
              </label>
              {model.femArrowColorMode === "monochrome" ? (
                <label className={ROW_B_HINT_CLASS}>
                  Monochrome
                  <input
                    type="color"
                    className="ml-1 h-7 w-10 rounded border border-border/35 bg-background/45 p-0.5 align-middle"
                    value={model.femArrowMonoColor}
                    onChange={(event) => model.setFemArrowMonoColor(event.target.value)}
                  />
                </label>
              ) : null}
            </>
          ) : (
            <label className={ROW_B_HINT_CLASS}>
              Voxel color mode
              <select
                className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
                value={fdmModule?.voxelColorMode ?? model.fdmVisualizationSettings.voxel_color_mode}
                onChange={(event) =>
                  patchFdmSettings({
                    voxelColorMode: event.target.value as "orientation" | "x" | "y" | "z",
                  })
                }
                disabled={!supportsStructuredGrid}
                title={
                  supportsStructuredGrid
                    ? "FDM voxel color mapping."
                    : "Requires structured_grid capability."
                }
              >
                <option value="orientation">orientation</option>
                <option value="x">x</option>
                <option value="y">y</option>
                <option value="z">z</option>
              </select>
            </label>
          )}
        </div>
      ) : null}

      {displaySettingsOpen ? (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-2 border-t border-border/20">
          <span className={ROW_B_GROUP_TITLE_CLASS}>Display</span>
          {!supportsTopology ? (
            <>
              <label className={ROW_B_HINT_CLASS}>
                Quality
                <select
                  className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
                  value={fdmModule?.quality ?? model.fdmVisualizationSettings.quality}
                  onChange={(event) =>
                    patchFdmSettings({
                      quality: event.target.value as "low" | "high" | "ultra",
                    })
                  }
                >
                  <option value="low">low</option>
                  <option value="high">high</option>
                  <option value="ultra">ultra</option>
                </select>
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Brightness
                <input
                  type="range"
                  className="ml-1 w-20 accent-primary align-middle"
                  min={0.3}
                  max={3}
                  step={0.1}
                  value={fdmBrightness}
                  onChange={(event) =>
                    patchFdmSettings({ brightness: Number(event.target.value) })
                  }
                />
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Voxel Opacity
                <input
                  type="range"
                  className="ml-1 w-20 accent-primary align-middle"
                  min={0.15}
                  max={0.95}
                  step={0.01}
                  value={fdmVoxelOpacity}
                  onChange={(event) =>
                    patchFdmSettings({ voxelOpacity: Number(event.target.value) })
                  }
                />
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Voxel Gap
                <input
                  type="range"
                  className="ml-1 w-20 accent-primary align-middle"
                  min={0.02}
                  max={0.42}
                  step={0.01}
                  value={fdmVoxelGap}
                  onChange={(event) =>
                    patchFdmSettings({ voxelGap: Number(event.target.value) })
                  }
                />
              </label>
              <label className={ROW_B_HINT_CLASS}>
                Voxel Threshold
                <input
                  type="range"
                  className="ml-1 w-20 accent-primary align-middle"
                  min={0}
                  max={0.95}
                  step={0.01}
                  value={fdmVoxelThreshold}
                  onChange={(event) =>
                    patchFdmSettings({ voxelThreshold: Number(event.target.value) })
                  }
                />
              </label>
            </>
          ) : (
            <span className={ROW_B_HINT_CLASS}>
              FEM display profile is controlled by render mode and layer toggles.
            </span>
          )}
        </div>
      ) : null}

      {topographySettingsOpen ? (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-2 border-t border-border/20">
          <span className={ROW_B_GROUP_TITLE_CLASS}>Topography</span>
          <label className={ROW_B_HINT_CLASS}>
            Enabled
            <input
              type="checkbox"
              className="ml-1 align-middle"
              checked={fdmTopographyEnabled}
              onChange={(event) =>
                patchFdmSettings({ topography: { enabled: event.target.checked } })
              }
              disabled={!supportsStructuredGrid}
              title={supportsStructuredGrid ? "Toggle topography layer." : "Requires structured_grid capability."}
            />
          </label>
          <label className={ROW_B_HINT_CLASS}>
            Axis
            <select
              className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
              value={fdmTopographyAxis}
              onChange={(event) =>
                patchFdmSettings({
                  topography: { component: event.target.value as "x" | "y" | "z" },
                })
              }
              disabled={!supportsStructuredGrid}
              title={supportsStructuredGrid ? "Topography axis." : "Requires structured_grid capability."}
            >
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
            </select>
          </label>
          <label className={ROW_B_HINT_CLASS}>
            Amplitude
            <input
              type="range"
              className="ml-1 w-20 accent-primary align-middle"
              min={0.5}
              max={50}
              step={0.5}
              value={fdmTopographyAmplitude}
              onChange={(event) =>
                patchFdmSettings({ topography: { amplitude: Number(event.target.value) } })
              }
              disabled={!supportsStructuredGrid}
              title={supportsStructuredGrid ? "Topography amplitude." : "Requires structured_grid capability."}
            />
          </label>
          {supportsStructuredGrid ? null : (
            <span className={ROW_B_HINT_CLASS}>Topography is available only for structured-grid runtime.</span>
          )}
        </div>
      ) : null}

      {cameraSettingsOpen ? (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-2 border-t border-border/20">
          <span className={ROW_B_GROUP_TITLE_CLASS}>Camera</span>
          <button
            type="button"
            className={ROW_B_BUTTON_CLASS}
            onClick={() => applyCameraPreset("reset")}
            disabled={!canFrameAll}
            title={canFrameAll ? "Reset camera (Frame All)." : authoringUnavailableReason}
          >
            Reset
          </button>
        </div>
      ) : null}

      {panelsOpen ? (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-3 border-t border-border/20">
          <span className={ROW_B_GROUP_TITLE_CLASS}>Panels</span>
          <label className={ROW_B_HINT_CLASS}>
            Legend
            <input
              type="checkbox"
              className="ml-1 align-middle"
              checked={model.viewportLegendVisible}
              onChange={(event) => {
                const next = event.target.checked;
                model.setViewportLegendVisible(next);
                dispatchToolbar({ type: "setLegendVisible", value: next });
              }}
              disabled={!supportsTopology}
              title={supportsTopology ? "Toggle field legend." : "Requires explicit_topology capability."}
            />
          </label>
          <label className={ROW_B_HINT_CLASS}>
            Part Explorer
            <input
              type="checkbox"
              className="ml-1 align-middle"
              checked={partExplorerOpen}
              onChange={() => togglePartExplorer()}
              disabled={!supportsTopology}
              title={supportsTopology ? "Toggle Selected Submeshes panel." : "Requires explicit_topology capability."}
            />
          </label>
        </div>
      ) : null}

      {snapSettingsOpen ? (
        <div className="px-3 pb-2 flex flex-wrap items-center gap-2 border-t border-border/20">
          <span className={ROW_B_GROUP_TITLE_CLASS}>Snap Settings</span>
          <label className={ROW_B_HINT_CLASS}>
            Translate (m)
            <input
              type="number"
              className="ml-1 h-7 w-28 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
              min={1e-12}
              step={1e-9}
              value={builderSnapSettings.translateStepMeters}
              onChange={(event) =>
                patchBuilderSnapSettings({
                  translateStepMeters: Math.max(Number(event.target.value) || 0, 1e-12),
                })
              }
              disabled={!supportsAuthoring}
            />
          </label>
          <label className={ROW_B_HINT_CLASS}>
            Rotate (deg)
            <input
              type="number"
              className="ml-1 h-7 w-20 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
              min={0.1}
              step={0.1}
              value={builderSnapSettings.rotateStepDeg}
              onChange={(event) =>
                patchBuilderSnapSettings({
                  rotateStepDeg: Math.max(Number(event.target.value) || 0, 0.1),
                })
              }
              disabled={!supportsAuthoring}
            />
          </label>
          <label className={ROW_B_HINT_CLASS}>
            Scale
            <input
              type="number"
              className="ml-1 h-7 w-20 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
              min={0.001}
              step={0.01}
              value={builderSnapSettings.scaleStep}
              onChange={(event) =>
                patchBuilderSnapSettings({
                  scaleStep: Math.max(Number(event.target.value) || 0, 0.001),
                })
              }
              disabled={!supportsAuthoring}
            />
          </label>
        </div>
      ) : null}

      {infoOpen ? (
        <div className="px-3 pb-2 border-t border-border/20 text-[0.7rem] text-muted-foreground">
          <div>Quantity: {viewport.requestedPreviewQuantity}</div>
          <div>View: {viewport.effectiveViewMode}</div>
          <div>
            Grid: {viewport.previewGrid[0]} × {viewport.previewGrid[1]} × {viewport.previewGrid[2]}
          </div>
          <div>
            Render mode: {supportsTopology ? model.meshRenderMode : (fdmModule?.renderMode ?? fdmRenderMode)}
          </div>
          <div>Objects visible: {model.objectOverlays.length}</div>
          <div>Builder active: {builderEnabled ? "yes" : "no"}</div>
        </div>
      ) : null}

      {rotationDebugOpen ? (
        <div className="px-3 pb-2 border-t border-border/20 text-[0.7rem] text-muted-foreground">
          <div className="font-semibold text-foreground/90">Rotation Debug</div>
          <div>Projection: {viewport3DModel.camera.projection}</div>
          <div>Navigation: {viewport3DModel.camera.navigation}</div>
          <div>Object view: {viewport3DModel.selection.objectViewMode}</div>
          <div>Last preset: {viewport3DModel.camera.lastPreset ?? "n/a"}</div>
        </div>
      ) : null}

      {liveRenderDebugOpen ? (
        <div className="px-3 pb-2 border-t border-border/20 text-[0.7rem] text-muted-foreground">
          <div className="font-semibold text-foreground/90">Live Render Debug</div>
          <div>Source: {viewport3DModel.debug.sourceKind}</div>
          <div>Field revision: {viewport3DModel.debug.fieldDataRevision ?? "n/a"}</div>
          <div>
            Field timestamp:{" "}
            {viewport3DModel.debug.fieldDataTimestamp != null
              ? new Date(viewport3DModel.debug.fieldDataTimestamp).toLocaleTimeString("pl-PL", {
                  hour12: false,
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })
              : "n/a"}
          </div>
          <div>Effective step: {viewport3DModel.debug.effectiveStep ?? "n/a"}</div>
        </div>
      ) : null}
    </div>
  );
});

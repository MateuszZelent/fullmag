"use client";

import { memo, useCallback, useEffect, useMemo, useReducer } from "react";

import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { getLiveApiClient } from "@/src/api/client/LiveApiClient";
import { useLiveStatus } from "@/src/hooks/resources/useLiveStatus";
import type { DisplayPatchRequest, FieldComponent, LiveStatus } from "@/src/api/types";
import { statusToViewport3DCapabilities } from "@/src/features/view3d/adapters/statusToCapabilities";
import { resourcesToViewportModel } from "@/src/features/view3d/adapters/resourcesToViewportModel";
import { runtimeToViewport3DToolbarState } from "@/src/features/view3d/adapters/runtimeToToolbarState";
import { UnifiedViewportBar } from "@/features/viewport-unified";
import { useUnifiedDisplayControls } from "@/features/viewport-unified/hooks/useUnifiedDisplayControls";
import {
  buildToolbarStateFromLegacy,
  buildViewport3DModelFromAdapter,
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
  Viewport3DCapabilities as UnifiedViewport3DCapabilities,
  Viewport3DFdmModulePatch,
} from "@/features/viewport-unified/model/viewport3dContracts";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";

import type { RenderMode } from "../../preview/FemMeshView3D";
import type { VectorComponent } from "./shared";
import { useCommand, useModel, useViewport } from "./context-hooks";

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

function mapCanonicalCapabilitiesToUnified(
  capabilities: ReturnType<typeof statusToViewport3DCapabilities>,
  authoringEnabled: boolean,
  diagnosticsEnabled: boolean,
): UnifiedViewport3DCapabilities {
  const preview3d = Boolean(capabilities.can_render_3d);
  const structuredGrid = preview3d && Boolean(capabilities.can_show_structured_grid);
  const explicitTopology = preview3d && Boolean(capabilities.can_show_topology);
  const authoringPrimitives = preview3d && explicitTopology && authoringEnabled;
  const vectorField = preview3d && Boolean(capabilities.can_show_vectors);
  const clip = preview3d && explicitTopology;
  const screenshot = preview3d;
  const diagnostics = preview3d && diagnosticsEnabled;

  return {
    preview3d: preview3d
      ? { enabled: true }
      : { enabled: false, reason: "Requires preview_3d capability." },
    structuredGrid: structuredGrid
      ? { enabled: true }
      : {
          enabled: false,
          reason: preview3d
            ? "Requires structured_grid capability."
            : "Requires preview_3d capability.",
        },
    explicitTopology: explicitTopology
      ? { enabled: true }
      : {
          enabled: false,
          reason: preview3d
            ? "Requires explicit_topology capability."
            : "Requires preview_3d capability.",
        },
    authoringPrimitives: authoringPrimitives
      ? { enabled: true }
      : {
          enabled: false,
          reason: preview3d
            ? (explicitTopology
                ? "Requires Geometry Authoring mode."
                : "Requires explicit_topology capability.")
            : "Requires preview_3d capability.",
        },
    vectorField: vectorField
      ? { enabled: true }
      : {
          enabled: false,
          reason: preview3d
            ? "Requires binary_fields + (node_fields|cell_fields) capability."
            : "Requires preview_3d capability.",
        },
    clip: clip
      ? { enabled: true }
      : {
          enabled: false,
          reason: preview3d
            ? "Requires explicit_topology capability."
            : "Requires preview_3d capability.",
        },
    screenshot: screenshot
      ? { enabled: true }
      : { enabled: false, reason: "Requires preview_3d capability." },
    diagnostics: diagnostics
      ? { enabled: true }
      : {
          enabled: false,
          reason: preview3d
            ? "Requires render diagnostics flag."
            : "Requires preview_3d capability.",
        },
  };
}

function toStatusResourcesSnapshot(
  resources: LiveStatus["resources"] | null | undefined,
): Pick<LiveStatus, "resources"> | null {
  if (!resources) {
    return null;
  }
  return { resources };
}

type GeometryTool = "camera" | "select" | "move" | "rotate" | "scale";

const ROW_B_BUTTON_CLASS =
  "h-7 rounded border border-border/35 bg-background/45 px-2 text-[0.68rem] text-foreground transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50";
const ROW_B_BUTTON_ACTIVE_CLASS =
  "h-7 rounded border border-primary/45 bg-primary/20 px-2 text-[0.68rem] text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const ROW_B_GROUP_TITLE_CLASS =
  "text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground";
const ROW_B_HINT_CLASS = "text-[0.66rem] text-muted-foreground";

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

  const patchDisplay = useCallback(async (patch: DisplayPatchRequest): Promise<void> => {
    await getLiveApiClient().display.patch(patch);
  }, []);

  const displayControls = useUnifiedDisplayControls(patchDisplay);

  const viewport3DContractCapabilities = useMemo(
    () =>
      statusToViewport3DCapabilities(
        status?.capabilities ? { capabilities: status.capabilities } : null,
      ),
    [status],
  );
  const capabilities = useMemo(
    () =>
      mapCanonicalCapabilitiesToUnified(
        viewport3DContractCapabilities,
        builderEnabled,
        FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging,
      ),
    [builderEnabled, viewport3DContractCapabilities],
  );

  const renderState = useMemo<UnifiedRenderState>(() => ({
    selectedLayer: status?.display.slice_layer ?? viewport.requestedPreviewLayer ?? viewport.sliceIndex,
    allLayersVisible:
      (status?.display.slice_mode ?? (viewport.requestedPreviewAllLayers ? "all" : "single")) === "all",
    vectorComponent: toUnifiedVectorComponent(
      status
        ? (status.display.view_mode === "3d" ? "3D" : status.display.field_component)
        : (viewport.previewControlsActive ? viewport.requestedPreviewComponent : viewport.component),
    ),
    colorScale: status?.display.colormap ?? "viridis",
    autoScale: status?.display.auto_contrast ?? viewport.requestedPreviewAutoScale,
    maxPoints: status?.display.max_points ?? viewport.requestedPreviewMaxPoints,
    everyN: status?.display.vector_density ?? viewport.requestedPreviewEveryN,
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
      model.setMeshRenderMode(fromUnifiedMeshRenderMode(next.meshRenderMode));
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
  const viewport3DContractModel = useMemo(
    () =>
      resourcesToViewportModel({
        status: toStatusResourcesSnapshot(status?.resources),
        quantity_id: viewport.requestedPreviewQuantity ?? null,
        component: toViewportFieldComponent(renderState.vectorComponent),
        selection: {
          object_id: model.viewportSelectedObjectId,
          part_id: model.selectedEntityId,
        },
        clip: {
          enabled: Boolean(renderState.clipEnabled),
          axis: renderState.clipAxis ?? "z",
          position:
            typeof renderState.clipPosition === "number"
              ? renderState.clipPosition
              : 50,
          invert: model.meshClipFlip,
        },
      }),
    [
      model.meshClipFlip,
      model.selectedEntityId,
      model.viewportSelectedObjectId,
      renderState.clipAxis,
      renderState.clipEnabled,
      renderState.clipPosition,
      renderState.vectorComponent,
      status?.resources,
      viewport.requestedPreviewQuantity,
    ],
  );
  const viewport3DContractToolbarState = useMemo(
    () =>
      runtimeToViewport3DToolbarState({
        capabilities: viewport3DContractCapabilities,
        has_topology:
          viewport3DContractModel.topology_revision != null || Boolean(model.femTopologyKey),
        has_field_data: viewport3DContractModel.field_revision != null,
      }),
    [
      model.femTopologyKey,
      viewport3DContractCapabilities,
      viewport3DContractModel.field_revision,
      viewport3DContractModel.topology_revision,
    ],
  );
  const viewport3DControlReasons = useMemo(
    () => ({
      quantity: viewport3DContractToolbarState.reasons.quantity,
      component: viewport3DContractToolbarState.reasons.component,
      clip: viewport3DContractToolbarState.reasons.clip,
      renderMode: viewport3DContractToolbarState.reasons.render_mode,
    }),
    [
      viewport3DContractToolbarState.reasons.clip,
      viewport3DContractToolbarState.reasons.component,
      viewport3DContractToolbarState.reasons.quantity,
      viewport3DContractToolbarState.reasons.render_mode,
    ],
  );
  const viewportToolbarState = useMemo(
    () => {
      const legacyToolbarState = buildToolbarStateFromLegacy({
        renderState,
        quantityId: viewport.requestedPreviewQuantity ?? null,
        clipFlip: model.meshClipFlip,
        interactionMode: toolbarState.rowB.interactionMode,
        snapEnabled: toolbarState.rowB.snapEnabled,
        objectViewMode: toolbarState.rowB.objectView,
        vectorsVisible: legacyFdmVectorsEnabled,
        legendVisible: toolbarState.rowB.legendVisible,
        partExplorerVisible: toolbarState.rowB.partExplorerVisible,
        projection: toolbarState.rowB.projection,
        navProfile: toolbarState.rowB.navProfile,
        popovers: toolbarState.popovers,
      });
      return {
        ...legacyToolbarState,
        rowA: {
          ...legacyToolbarState.rowA,
          clipEnabled:
            legacyToolbarState.rowA.clipEnabled && viewport3DContractToolbarState.clip_enabled,
        },
        controlStates: {
          ...legacyToolbarState.controlStates,
          quantity: viewport3DContractToolbarState.quantity_enabled
            ? ("inactive" as const)
            : ("disabled" as const),
          component: viewport3DContractToolbarState.component_enabled
            ? ("inactive" as const)
            : ("disabled" as const),
          clip: viewport3DContractToolbarState.clip_enabled
            ? ("inactive" as const)
            : ("disabled" as const),
          renderMode: viewport3DContractToolbarState.render_mode_enabled
            ? ("inactive" as const)
            : ("disabled" as const),
        },
      };
    },
    [
      legacyFdmVectorsEnabled,
      model.meshClipFlip,
      renderState,
      toolbarState.popovers,
      toolbarState.rowB.interactionMode,
      toolbarState.rowB.legendVisible,
      toolbarState.rowB.navProfile,
      toolbarState.rowB.objectView,
      toolbarState.rowB.partExplorerVisible,
      toolbarState.rowB.projection,
      toolbarState.rowB.snapEnabled,
      viewport3DContractToolbarState.clip_enabled,
      viewport3DContractToolbarState.component_enabled,
      viewport3DContractToolbarState.quantity_enabled,
      viewport3DContractToolbarState.render_mode_enabled,
      viewport.requestedPreviewQuantity,
    ],
  );
  const viewport3DModel = useMemo(
    () =>
      buildViewport3DModelFromAdapter({
        discretization: command.isFemBackend ? "fem" : "fdm",
        renderState,
        toolbarState: viewportToolbarState,
        capabilities,
        worldExtent: model.worldExtent,
        worldCenter: model.worldCenter,
        topologyRevision:
          viewport3DContractModel.topology_revision != null
            ? String(viewport3DContractModel.topology_revision)
            : model.femTopologyKey,
        fieldRevision:
          viewport3DContractModel.field_revision != null
            ? String(viewport3DContractModel.field_revision)
            : null,
        quantityId: viewport3DContractModel.quantity_id,
        selectedObjectId: viewport3DContractModel.selection.object_id,
        selectedEntityId: viewport3DContractModel.selection.part_id ?? model.selectedEntityId,
        focusedEntityId: model.focusedEntityId,
        selectedSidebarNodeId: model.selectedSidebarNodeId,
        loading: viewport.previewBusy,
        message: viewport.previewMessage,
        error: command.error,
        pendingMeshBuild: model.meshConfigDirty,
        sourceKind: status ? "live" : "none",
        fdmSettings: model.fdmVisualizationSettings,
        fdmVectorsVisible: legacyFdmVectorsEnabled,
      }),
    [
      capabilities,
      command.error,
      command.isFemBackend,
      legacyFdmVectorsEnabled,
      model.fdmVisualizationSettings,
      model.femTopologyKey,
      model.focusedEntityId,
      model.meshConfigDirty,
      model.selectedEntityId,
      model.selectedSidebarNodeId,
      model.worldCenter,
      model.worldExtent,
      renderState,
      status,
      viewport3DContractModel.field_revision,
      viewport3DContractModel.quantity_id,
      viewport3DContractModel.selection.object_id,
      viewport3DContractModel.selection.part_id,
      viewport3DContractModel.topology_revision,
      viewport.previewBusy,
      viewport.previewMessage,
      viewportToolbarState,
    ],
  );
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
  const cameraProjection = toolbarState.rowB.projection === "orthographic" ? "ortho" : "persp";
  const cameraNavigation = toolbarState.rowB.navProfile;

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
        onQuantityChange={viewport.requestPreviewQuantity}
        clipFlip={model.meshClipFlip}
        onClipFlipChange={model.setMeshClipFlip}
        controlStates={viewportToolbarState.controlStates}
        controlReasons={viewport3DControlReasons}
      />

      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-border/20">
        <span className={ROW_B_GROUP_TITLE_CLASS}>Tools</span>
        {(
          [
            { tool: "camera", label: "Q Camera", disabled: !supports3D, title: "Camera navigation mode (Q)" },
            { tool: "select", label: "S Select", disabled: !supportsAuthoring, title: supportsAuthoring ? "Selection mode (S)." : authoringUnavailableReason },
            { tool: "move", label: "W Move", disabled: !supportsAuthoring, title: supportsAuthoring ? "Move tool (W)." : authoringUnavailableReason },
            { tool: "rotate", label: "E Rotate", disabled: !supportsAuthoring, title: supportsAuthoring ? "Rotate tool (E)." : authoringUnavailableReason },
            { tool: "scale", label: "R Scale", disabled: !supportsAuthoring, title: supportsAuthoring ? "Scale tool (R)." : authoringUnavailableReason },
          ] as Array<{ tool: GeometryTool; label: string; disabled: boolean; title: string }>
        ).map((entry) => (
          <button
            key={entry.tool}
            type="button"
            className={activeTool === entry.tool ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
            onClick={() => setTool(entry.tool)}
            disabled={entry.disabled}
            title={entry.title}
          >
            {entry.label}
          </button>
        ))}

        <button
          type="button"
          className={builderSnapSettings.enabled ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => {
            const next = !builderSnapSettings.enabled;
            toggleBuilderSnap();
            dispatchToolbar({ type: "setSnapEnabled", value: next });
          }}
          disabled={!supportsAuthoring}
          title={supportsAuthoring ? "Toggle transform snap (G)." : authoringUnavailableReason}
        >
          G Snap
        </button>

        <button
          type="button"
          className={snapSettingsOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "snapSettings" })}
          disabled={!supportsAuthoring}
          title={supportsAuthoring ? "Open snap settings." : authoringUnavailableReason}
        >
          Snap Settings
        </button>

        <button
          type="button"
          className={ROW_B_BUTTON_CLASS}
          onClick={() => focusSelected()}
          disabled={!canFocusSelected}
          title={canFocusSelected ? "Focus selected (F)" : "Requires selected object or authoring_primitives."}
        >
          F Focus
        </button>

        <button
          type="button"
          className={ROW_B_BUTTON_CLASS}
          onClick={() => frameAll()}
          disabled={!canFrameAll}
          title={canFrameAll ? "Frame all (Shift+F)." : authoringUnavailableReason}
        >
          Shift+F Frame All
        </button>

        <span className={ROW_B_GROUP_TITLE_CLASS}>Object View</span>
        <button
          type="button"
          className={model.objectViewMode === "context" ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => {
            model.setObjectViewMode("context");
            dispatchToolbar({ type: "setObjectView", value: "context" });
          }}
          title="Show context objects"
        >
          Context
        </button>
        <button
          type="button"
          className={model.objectViewMode === "isolate" ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => {
            model.setObjectViewMode("isolate");
            dispatchToolbar({ type: "setObjectView", value: "isolate" });
          }}
          title="Isolate selected object"
        >
          Isolate
        </button>

        <button
          type="button"
          className={vectorsEnabled ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => toggleVectors()}
          disabled={!supports3D}
          title={supports3D ? "Toggle vectors/glyph layer" : "Requires preview_3d capability."}
        >
          Vectors {vectorsEnabled ? "ON" : "OFF"}
        </button>

        <button
          type="button"
          className={vectorsSettingsOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "vectors" })}
          disabled={!supports3D}
          title={supports3D ? "Open vectors settings" : "Requires preview_3d capability."}
        >
          Vectors Settings
        </button>

        <button
          type="button"
          className={colorSettingsOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "color" })}
          disabled={!supports3D}
          title={supports3D ? "Color popover: surface/arrow/voxel color modes." : "Requires preview_3d capability."}
        >
          Color
        </button>

        <button
          type="button"
          className={displaySettingsOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "display" })}
          disabled={!supports3D}
          title={supports3D ? "Display popover: quality and visual profile controls." : "Requires preview_3d capability."}
        >
          Display
        </button>

        <button
          type="button"
          className={topographySettingsOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "topography" })}
          disabled={!supportsStructuredGrid}
          title={supportsStructuredGrid ? "Topography popover for structured-grid views." : "Requires structured_grid capability."}
        >
          Topography
        </button>

        <button
          type="button"
          className={cameraSettingsOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "camera" })}
          disabled={!supports3D}
          title={supports3D ? "Camera popover: projection, navigation, presets." : "Requires preview_3d capability."}
        >
          Camera
        </button>

        <button
          type="button"
          className={ROW_B_BUTTON_CLASS}
          onClick={() => viewport.handleCapture()}
          disabled={!supports3D}
          title={supports3D ? "Screenshot" : "Requires preview_3d capability."}
        >
          Screenshot
        </button>

        <button
          type="button"
          className={panelsOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "panels" })}
          title="Panels popover: legend and part explorer."
        >
          Panels
        </button>

        <button
          type="button"
          className={infoOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "info" })}
          title="Scene and renderer info"
        >
          Info
        </button>

        <button
          type="button"
          className={rotationDebugOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "rotationDebug" })}
          disabled={!capabilities.diagnostics.enabled}
          title={capabilities.diagnostics.enabled
            ? "Rotation debug popover"
            : (capabilities.diagnostics.reason ?? "Diagnostics unavailable")}
        >
          Rotation Debug
        </button>

        <button
          type="button"
          className={liveRenderDebugOpen ? ROW_B_BUTTON_ACTIVE_CLASS : ROW_B_BUTTON_CLASS}
          onClick={() => dispatchToolbar({ type: "togglePopover", key: "liveRenderDebug" })}
          disabled={!capabilities.diagnostics.enabled}
          title={capabilities.diagnostics.enabled
            ? "Live render debug popover"
            : (capabilities.diagnostics.reason ?? "Diagnostics unavailable")}
        >
          Live Render Debug
        </button>

        <span className={ROW_B_HINT_CLASS}>
          Capabilities: preview_3d={supports3D ? "yes" : "no"} · explicit_topology={supportsTopology ? "yes" : "no"} · structured_grid={supportsStructuredGrid ? "yes" : "no"} · authoring_tools={supportsAuthoring ? "active" : "inactive"}
        </span>
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
          <label className={ROW_B_HINT_CLASS}>
            Projection
            <select
              className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
              value={cameraProjection}
              onChange={(event) =>
                dispatchToolbar({
                  type: "setProjection",
                  value: event.target.value === "ortho" ? "orthographic" : "perspective",
                })
              }
              disabled
              title="Projection switching will be wired into shared camera adapter."
            >
              <option value="persp">persp</option>
              <option value="ortho">ortho</option>
            </select>
          </label>
          <label className={ROW_B_HINT_CLASS}>
            Navigation
            <select
              className="ml-1 h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
              value={cameraNavigation}
              onChange={(event) =>
                dispatchToolbar({
                  type: "setNavigationProfile",
                  value: event.target.value as "trackball" | "cad",
                })
              }
              disabled
              title="Navigation profile switching will be wired into shared camera adapter."
            >
              <option value="trackball">trackball</option>
              <option value="cad">cad</option>
            </select>
          </label>
          <span className={ROW_B_GROUP_TITLE_CLASS}>Presets</span>
          <button
            type="button"
            className={ROW_B_BUTTON_CLASS}
            onClick={() => applyCameraPreset("reset")}
            disabled={!canFrameAll}
            title={canFrameAll ? "Reset camera (Frame All)." : authoringUnavailableReason}
          >
            Reset
          </button>
          {(["front", "top", "right", "iso"] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              className={ROW_B_BUTTON_CLASS}
              onClick={() => applyCameraPreset(preset)}
              disabled
              title="Preset camera orientation will be available via shared camera adapter."
            >
              {preset[0].toUpperCase() + preset.slice(1)}
            </button>
          ))}
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
              checked={false}
              disabled
              title="Legend visibility toggle is being moved into shared overlay state."
              readOnly
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SetStateAction } from "react";
import { MAGNETIC_PRESET_CATALOG } from "@/lib/magnetizationPresetCatalog";
import {
  incrementFrontendAuditCounter,
  measureFrontendAudit,
  setFrontendAuditCounter,
} from "@/lib/debug/frontendAudit";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { writeFrontendDiagnosticConsole } from "@/lib/debug/frontendConsoleDebug";
import { useBuilderKeyboardShortcuts } from "@/features/geometry-builder";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import { displayPatchFromPreviewComponentOnly } from "@/src/api/displaySelection";
import type { DisplaySelection } from "@/src/api/types";
import { useField2DResource } from "@/src/hooks/resources/useFieldSlice2D";
import type { Field2DResourceRequest } from "@/src/hooks/resources/useFieldSlice2D";
import {
  useMeshWorkspaceModel,
  useSubmitMeshBuildCommand,
} from "@/src/hooks/resources/useMeshResources";
import { useSlice2DModel } from "@/src/hooks/resources/useSliceResource";
import { useSlice2DToolbarStore } from "@/src/features/slice2d";
import {
  planeFromSliceAxis,
  positionPercentFromSliceIndex,
  resolveSliceAxisSelection,
  sliceIndexFromPositionPercent,
  sliceAxisFromPlane,
} from "@/src/features/slice2d/axisMapping";
import { selectionFromControlRoomState } from "@/src/features/workspaceSync";
import type { MeshWorkspaceModel } from "@/src/features/meshWorkspace";
import type { Slice2DModel } from "@/src/features/slice2d";
import { useViewport3DController } from "@/features/viewport-unified/hooks/useViewport3DController";
import {
  isViewport3DVectorFieldRenderable,
  useViewport3DVectorFieldModel,
} from "@/features/viewport-unified/hooks/useViewport3DVectorFieldModel";
import { resolveViewportInternalToolbarModes } from "@/features/viewport-unified/registry/viewport3dRenderRegistry";
import { mapRouteFlagsToViewport3DStages } from "@/features/viewport-unified/model/viewport3dFlags";
import { resolveViewport3DRolloutRoute } from "@/features/viewport-unified/model/viewport3dRolloutRoute";
import { useViewport3DUpdateClassification } from "@/features/viewport-unified/hooks/useViewport3DUpdateClassification";
import { useViewport3DRolloutTelemetry } from "@/features/viewport-unified/hooks/useViewport3DRolloutTelemetry";
import {
  buildFemLiveRenderDebugData,
} from "@/features/viewport-unified/model/femLiveRenderDebugData";
import {
  rebuildSlice2DModelFrame,
  resolveSlice2DFieldRequestState,
  resolveSlice2DFieldRevision,
} from "@/features/viewport-unified/model/slice2DRequestModel";
import {
  buildVectorLiveRenderDebugData,
} from "@/features/viewport-unified/model/vectorLiveRenderDebugData";
import {
  resolveViewportBridgeActivity,
  type ViewportBridgeMode,
} from "@/features/viewport-unified/model/viewportBridgeActivity";
import { resolveViewport3DFieldRoles } from "@/features/viewport-unified/model/viewport3dFieldRoles";
import {
  buildViewportFitSeed,
  useViewportGraphCameraBridge,
} from "@/features/viewport-unified/camera-lifecycle";
import type { Viewport3DInteractionMode } from "@/features/viewport-unified/model/viewport3dContracts";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";
import {
  useFdmVisualizationSettings,
  useVectorState,
  useViewportRenderState,
} from "@/features/visualization/hooks/useVizSlice";
import { useSelectionActions, useSelectionState } from "@/features/selection";
import { useVisualizationStore } from "@/features/visualization/store/useVisualizationStore";
import type { UnifiedRenderState } from "@/features/viewport-unified/model/unifiedViewportTypes";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import type { TextureTransform3D as PreviewTextureTransform3D } from "@/lib/textureTransform";
import type { TextureGizmoMode } from "@/components/preview/TextureTransformGizmo";
import type { RenderMode as FemRenderMode } from "@/components/preview/FemMeshView3D";
import { downsampleVectorFieldSpatialBins } from "@/components/preview/fem/femFieldDownsample";
import { shouldFlagMissingExactScopeSegment } from "@/components/preview/fem/useFemViewportDerivedModel";
import { resolveAntennaNodeName } from "@/components/runs/control-room/shared";
import {
  buildDenseFemVectorField,
  deriveFemVectorScopes,
} from "@/components/runs/control-room/femVectorScopes";
import {
  useTransport,
  useViewport,
  useCommand,
  useModel,
} from "@/components/runs/control-room/context-hooks";
import {
  toPreviewTextureTransform,
  toSceneTextureTransform,
  textureTransformToWorld,
  textureTransformToLocal,
} from "@/components/runs/control-room/viewportUtils";
import type { Vec3, Quat } from "@/components/runs/control-room/viewportUtils";
import {
  deriveFemLayerRenderState,
  resolveMagneticTextureColorField,
} from "@/components/runs/control-room/viewportLayers";
import {
  visualizationPatchForClip,
  visualizationPatchForFemLayers,
  visualizationPatchForOpacity,
  visualizationPatchForRenderMode,
} from "@/components/runs/control-room/visualizationStateSync";
import {
  resolveEffectiveFemMeshEntityViewStateFromRenderPlan,
} from "@/components/runs/control-room/resolvedRenderPlanView";
import type { MeshEntityViewState, MeshEntityViewStateMap } from "@/lib/session/types";
import { defaultMeshEntityViewState } from "@/lib/session/types";

/* ── Debug flag ───────────────────────────────────────────────────── */
const DEBUG_GIZMO_SYNC =
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace &&
  process.env.NODE_ENV !== "production";
const VIEWPORT_BRIDGE_DEBUG_LOGS =
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace &&
  process.env.NODE_ENV !== "production";

function logViewportBridgeDebug(event: string, payload?: Record<string, unknown>): void {
  if (!VIEWPORT_BRIDGE_DEBUG_LOGS) {
    return;
  }
  if (payload) {
    writeFrontendDiagnosticConsole("info", `[viewport3d:bridge] ${event}`, payload);
    return;
  }
  writeFrontendDiagnosticConsole("info", `[viewport3d:bridge] ${event}`);
}

/* ── Pure utility functions ───────────────────────────────────────── */

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function toUnifiedVectorComponent(component: string): UnifiedRenderState["vectorComponent"] {
  if (component === "3D" || component === "x" || component === "y" || component === "z") {
    return component;
  }
  return "|v|";
}

function toUnifiedRenderMode(
  mode: FemRenderMode,
): NonNullable<UnifiedRenderState["meshRenderMode"]> {
  if (mode === "wireframe" || mode === "points") return mode;
  if (mode === "surface+edges") return "solid+wireframe";
  return "solid";
}

function meshWorkspaceRenderModeToFem(
  mode: MeshWorkspaceModel["toolbar"]["renderMode"],
): FemRenderMode {
  if (mode === "solid+wireframe") return "surface+edges";
  if (mode === "wireframe" || mode === "points") return mode;
  return "surface";
}

export function resolveEffectiveMeshEntityRenderMode(args: {
  currentRenderMode: MeshEntityViewState["renderMode"];
}): MeshEntityViewState["renderMode"] {
  const { currentRenderMode } = args;
  // Keep the user-requested render mode unchanged for all roles.
  return currentRenderMode;
}

function toViewportInteractionMode(tool: string): Viewport3DInteractionMode {
  if (
    tool === "camera" ||
    tool === "select" ||
    tool === "move" ||
    tool === "rotate" ||
    tool === "scale"
  ) {
    return tool;
  }
  return "camera";
}

function toViewportFieldComponent(
  component: string,
): import("@/src/api/types").FieldComponent | null {
  if (
    component === "full" ||
    component === "magnitude" ||
    component === "x" ||
    component === "y" ||
    component === "z"
  ) {
    return component;
  }
  if (component === "3D" || component === "|v|") return "magnitude";
  return null;
}

function toDisplayFieldComponent(
  component: string,
): DisplaySelection["field_component"] {
  if (component === "x" || component === "y" || component === "z") return component;
  return "magnitude";
}

function numericRevision(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function scaleFieldComponentForRender(
  values: ArrayLike<number> | null | undefined,
  scaleFactor: number,
): Float32Array | null {
  if (!values) return null;
  const scaled = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    scaled[index] = values[index] * scaleFactor;
  }
  return scaled;
}

function deriveSliceSampling(
  grid: [number, number, number],
  plane: "xy" | "xz" | "yz",
  sliceIndex: number,
): { cutNorm: number; xPixels: number; yPixels: number } {
  const [nx, ny, nz] = grid;
  if (plane === "xy") {
    const maxIndex = Math.max(nz - 1, 0);
    return {
      cutNorm: maxIndex > 0 ? clamp01(sliceIndex / maxIndex) : 0.5,
      xPixels: Math.max(nx, 1),
      yPixels: Math.max(ny, 1),
    };
  }
  if (plane === "xz") {
    const maxIndex = Math.max(ny - 1, 0);
    return {
      cutNorm: maxIndex > 0 ? clamp01(sliceIndex / maxIndex) : 0.5,
      xPixels: Math.max(nx, 1),
      yPixels: Math.max(nz, 1),
    };
  }
  const maxIndex = Math.max(nx - 1, 0);
  return {
    cutNorm: maxIndex > 0 ? clamp01(sliceIndex / maxIndex) : 0.5,
    xPixels: Math.max(ny, 1),
    yPixels: Math.max(nz, 1),
  };
}

function quatToEulerDeg(q: [number, number, number, number]): [number, number, number] {
  const [x, y, z, w] = q;
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const rx = Math.atan2(sinrCosp, cosrCosp);
  const sinp = 2 * (w * y - z * x);
  const ry = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const rz = Math.atan2(sinyCosp, cosyCosp);
  const toDeg = 180 / Math.PI;
  return [rx * toDeg, ry * toDeg, rz * toDeg];
}

function hasMeaningfulRotation(q: [number, number, number, number]): boolean {
  return (
    Math.abs(q[0]) > 1e-6 ||
    Math.abs(q[1]) > 1e-6 ||
    Math.abs(q[2]) > 1e-6 ||
    Math.abs(q[3] - 1) > 1e-6
  );
}

function summarizeTransform(transform: {
  translation: Vec3;
  rotation_quat: Quat;
  scale: Vec3;
}) {
  return {
    translation: transform.translation,
    rotation_quat: transform.rotation_quat,
    rotation_euler_deg_xyz: quatToEulerDeg(transform.rotation_quat),
    scale: transform.scale,
  };
}

/* ── Hook ─────────────────────────────────────────────────────────── */

/**
 * Aggregates all data-fetching, computation, and callback logic for
 * `ViewportCanvasArea`. Returns a `ViewportDataBridge` object that
 * `ViewportTabContent` consumes.
 */
export interface UseViewportDataBridgeOptions {
  active?: boolean;
  viewportMode?: ViewportBridgeMode;
}

export function useViewportDataBridge(options: UseViewportDataBridgeOptions = {}) {
  /* ── Context ── */
  const _transport = useTransport();
  const _viewport = useViewport();
  const _cmd = useCommand();
  const _model = useModel();
  const ctx = useMemo(
    () => ({ ..._transport, ..._viewport, ..._cmd, ..._model }),
    [_transport, _viewport, _cmd, _model],
  );
  const bridgeActive = options.active ?? true;
  const bridgeViewportMode = options.viewportMode ?? ctx.effectiveViewMode;
  useEffect(() => {
    incrementFrontendAuditCounter("viewportBridgeMounted", 1);
    return () => {
      incrementFrontendAuditCounter("viewportBridgeMounted", -1);
    };
  }, []);
  useEffect(() => {
    setFrontendAuditCounter("viewportBridgeActive", bridgeActive ? 1 : 0);
    return () => {
      setFrontendAuditCounter("viewportBridgeActive", 0);
    };
  }, [bridgeActive]);
  const viz = useViewportRenderState();
  const vectorViz = useVectorState();
  const fdmVisualizationSettings = useFdmVisualizationSettings();
  const selection = useSelectionState();
  const { setSelectedObjectId, setSelectedSidebarNodeId } = useSelectionActions();
  const setFdmVisualizationSettingsAction = useCallback(
    (action: SetStateAction<typeof fdmVisualizationSettings>) => {
      const store = useVisualizationStore.getState();
      const next =
        typeof action === "function"
          ? (action as (value: typeof fdmVisualizationSettings) => typeof fdmVisualizationSettings)(
              store.fdmVisualizationSettings,
            )
          : action;
      store.setFdmVisualizationSettings(next);
    },
    [],
  );

  /* ── Session runtime ── */
  const runtimeSessionId = useSessionRuntimeStore((s) => s.session?.session_id ?? null);
  const runtimeResourceRevisions = useSessionRuntimeStore((s) => s.resourceRevisions);

  /* ── Toolbar patch state ── */
  const [meshWorkspaceToolbarPatch, setMeshWorkspaceToolbarPatch] = useState<
    Partial<MeshWorkspaceModel["toolbar"]>
  >({});
  const slice2DToolbarPatch = useSlice2DToolbarStore((state) => state.patch);
  const patchSlice2DToolbar = useSlice2DToolbarStore((state) => state.patchToolbar);

  /* ── Workspace selection ── */
  const workspaceSelection = useMemo(
    () =>
      selectionFromControlRoomState({
        selectedObjectId: selection.selectedObjectId,
        selectedEntityId: selection.selectedEntityId,
        selectedSidebarNodeId: selection.selectedSidebarNodeId,
        sourceSurface:
          ctx.effectiveViewMode === "2D"
              ? "slice2d"
              : "viewport3d",
      }),
    [
      ctx.effectiveViewMode,
      selection.selectedEntityId,
      selection.selectedObjectId,
      selection.selectedSidebarNodeId,
    ],
  );

  /* ── Geometry builder state ── */
  const builderEnabled = useGeometryBuilderStore((s) => s.builderMode.enabled);
  const builderViewportTool = useGeometryBuilderStore((s) => s.viewportTool);
  const builderSnapSettings = useGeometryBuilderStore((s) => s.snapSettings);
  const builderMeshSnapshot = useGeometryBuilderStore((s) => s.meshSnapshot);
  const builderGeometryRealization = useGeometryBuilderStore((s) => s.geometryRealization);
  const builderMeshDirty = useGeometryBuilderStore((s) => s.dirty.meshDirty);
  useBuilderKeyboardShortcuts();

  /* ── FEM discretization ── */
  const femDiscretization = resolveFemDiscretization(ctx.domainCapabilities, false);

  /* ── Mesh workspace resource ── */
  const meshWorkspaceResource = useMeshWorkspaceModel({
    enabled: false,
    sessionKey: runtimeSessionId,
    resources: runtimeResourceRevisions,
    liveCapabilities: ctx.domainCapabilities,
  });
  const meshBuildCommand = useSubmitMeshBuildCommand({
    enabled: false,
    sessionKey: runtimeSessionId,
  });

  /* ── ctx aliases (used in callbacks below) ── */
  const requestDisplayQuantity = ctx.requestDisplayQuantity;
  const setPlane = ctx.setPlane;
  const setSliceIndex = ctx.setSliceIndex;

  const handleMeshWorkspaceBuild = useCallback(() => {
    void meshBuildCommand
      .submit({ mesh_target: { kind: "study_domain" }, mesh_reason: "mesh_workspace_shell" })
      .then(() => meshWorkspaceResource.refresh());
  }, [meshBuildCommand, meshWorkspaceResource]);

  const effectiveMeshWorkspaceModel = useMemo<MeshWorkspaceModel | null>(() => {
    if (!meshWorkspaceResource.model) return null;
    return {
      ...meshWorkspaceResource.model,
      toolbar: { ...meshWorkspaceResource.model.toolbar, ...meshWorkspaceToolbarPatch },
    };
  }, [meshWorkspaceResource.model, meshWorkspaceToolbarPatch]);

  const handleMeshWorkspaceToolbarChange = useCallback(
    (patch: Partial<MeshWorkspaceModel["toolbar"]>) => {
      setMeshWorkspaceToolbarPatch((previous) => ({ ...previous, ...patch }));
      const renderPatch = patch.renderMode
        ? visualizationPatchForRenderMode(meshWorkspaceRenderModeToFem(patch.renderMode))
        : null;
      const opacityPatch =
        typeof patch.opacity === "number" ? visualizationPatchForOpacity(patch.opacity) : null;
      const clipPatch = visualizationPatchForClip({
        enabled: patch.clipEnabled,
        axis: patch.clipAxis,
        positionPercent: patch.clipPosition,
      });
      void ctx.patchDisplay({
        ...renderPatch,
        ...clipPatch,
        layers: {
          ...renderPatch?.layers,
          ...opacityPatch?.layers,
        },
      });
    },
    [ctx],
  );

  /* ── Derived flags ── */
  const showGeometryAuthoringViewport = false;
  const activeCoreTab = useWorkspaceStore((state) => state.activeCoreTab);
  const geometryViewportPresetActive = activeCoreTab === "Geometry";
  const minimalViewportSelectionPath =
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.useMinimalViewportSelectionPath;

  /* ── Workspace store (right inspector) ── */
  const meshParts = ctx.meshParts;
  const setMeshEntityViewState = ctx.setMeshEntityViewState;
  const rightInspectorOpen = useWorkspaceStore((state) => state.rightInspectorOpen);
  const setRightInspectorOpen = useWorkspaceStore((state) => state.setRightInspectorOpen);
  const rightInspectorTab = useWorkspaceStore((state) => state.rightInspectorTab);
  const setRightInspectorTab = useWorkspaceStore((state) => state.setRightInspectorTab);

  const {
    graphActiveViewportDocument,
    graphViewportResultNodeId,
    graphActiveViewportDocumentId,
    graphActiveViewportCameraState,
    persistViewportCameraState,
    setViewportCameraInteractionActive,
  } = useViewportGraphCameraBridge(logViewportBridgeDebug);

  /* ── Derived values from ctx ── */
  const effectiveViewMode = ctx.effectiveViewMode;
  const femMeshData = ctx.femMeshData;
  const viewportSelectedObjectId = ctx.viewportSelectedObjectId;
  const spatialPreview = ctx.preview?.kind === "spatial" ? ctx.preview : null;
  const globalScalarPreview = ctx.preview?.kind === "global_scalar" ? ctx.preview : null;

  /* ── Vector field revision ── */
  const vectorFieldRevision =
    runtimeResourceRevisions?.fields_revision ??
    runtimeResourceRevisions?.field_revision ??
    numericRevision(ctx.fieldDataRevision) ??
    ctx.liveFieldSourceStep ??
    ctx.effectiveStep ??
    null;
  const vectorDomainGenerationId = runtimeResourceRevisions?.domain_generation_id ?? 0;

  const quantityDescriptorByIdFor3D = useMemo(
    () => new Map(ctx.quantities.map((quantity) => [quantity.id, quantity] as const)),
    [ctx.quantities],
  );
  const viewport3DFieldRoles = useMemo(
    () =>
      resolveViewport3DFieldRoles({
        selectedQuantity: ctx.selectedQuantity ?? null,
        quantities: ctx.quantities,
        showQuantity: viz.femViewportLayers.showQuantity,
        showMagneticTexture: viz.femViewportLayers.showMagneticTexture,
        vectorDomainFilter: vectorViz.domainFilter,
      }),
    [
      ctx.quantities,
      ctx.selectedQuantity,
      vectorViz.domainFilter,
      viz.femViewportLayers.showMagneticTexture,
      viz.femViewportLayers.showQuantity,
    ],
  );
  const glyphQuantityDescriptor =
    viewport3DFieldRoles.glyphQuantityId
      ? quantityDescriptorByIdFor3D.get(viewport3DFieldRoles.glyphQuantityId) ?? null
      : null;
  const shaderQuantityDescriptor =
    viewport3DFieldRoles.shaderQuantityId
      ? quantityDescriptorByIdFor3D.get(viewport3DFieldRoles.shaderQuantityId) ?? null
      : null;

  /* ── FEM vector scopes ── */
  const glyphFemVectorScopes = useMemo(
    () =>
      deriveFemVectorScopes({
        meshParts: ctx.meshParts,
        meshEntityViewState: ctx.meshEntityViewState,
        airMeshVisible: viz.airMeshVisible,
        vectorDomainFilter: vectorViz.domainFilter,
        selectedFieldDomain: glyphQuantityDescriptor?.domain ?? femMeshData?.quantityDomain ?? null,
      }),
    [
      viz.airMeshVisible,
      vectorViz.domainFilter,
      ctx.meshEntityViewState,
      ctx.meshParts,
      femMeshData?.quantityDomain,
      glyphQuantityDescriptor?.domain,
    ],
  );
  const shaderFemVectorScopes = useMemo(
    () =>
      deriveFemVectorScopes({
        meshParts: ctx.meshParts,
        meshEntityViewState: ctx.meshEntityViewState,
        airMeshVisible: viz.airMeshVisible,
        vectorDomainFilter: vectorViz.domainFilter,
        selectedFieldDomain: shaderQuantityDescriptor?.domain ?? femMeshData?.quantityDomain ?? null,
      }),
    [
      viz.airMeshVisible,
      vectorViz.domainFilter,
      ctx.meshEntityViewState,
      ctx.meshParts,
      femMeshData?.quantityDomain,
      shaderQuantityDescriptor?.domain,
    ],
  );
  const glyphVectorFetchScope =
    femDiscretization && glyphFemVectorScopes.length === 1
      ? glyphFemVectorScopes[0]
      : { kind: "full" as const };
  const shaderVectorFetchScope =
    femDiscretization && shaderFemVectorScopes.length === 1
      ? shaderFemVectorScopes[0]
      : { kind: "full" as const };
  const glyphVectorAdapterPointCount = femDiscretization
    ? glyphVectorFetchScope.kind !== "full"
      ? null
      : glyphQuantityDescriptor?.location === "cell"
        ? ctx.femMeshData?.nElements ?? null
        : ctx.femMeshData?.nNodes ?? null
    : Math.max(0, ctx.previewGrid[0] * ctx.previewGrid[1] * ctx.previewGrid[2]);
  const shaderVectorAdapterPointCount = femDiscretization
    ? shaderVectorFetchScope.kind !== "full"
      ? null
      : shaderQuantityDescriptor?.location === "cell"
        ? ctx.femMeshData?.nElements ?? null
        : ctx.femMeshData?.nNodes ?? null
    : Math.max(0, ctx.previewGrid[0] * ctx.previewGrid[1] * ctx.previewGrid[2]);
  const vectorCapabilityEnabled = Boolean(
    ctx.domainCapabilities?.preview_3d &&
      ctx.domainCapabilities.binary_fields &&
      (femDiscretization
        ? ctx.domainCapabilities.explicit_topology && ctx.domainCapabilities.node_fields
        : ctx.domainCapabilities.structured_grid || ctx.domainCapabilities.explicit_topology),
  );
  const sliceApiFeatureEnabled = ctx.isFemBackend
    ? FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFemSlice2D
    : FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFdmSlice2D;
  const femSliceTopologyReady = !ctx.isFemBackend || Boolean(ctx.femMeshData);
  const bridgeActivity = resolveViewportBridgeActivity({
    active: bridgeActive,
    viewportMode: bridgeViewportMode,
    showArrows: vectorViz.showArrows,
    showQuantity: viz.femViewportLayers.showQuantity,
    showMagneticTexture: viz.femViewportLayers.showMagneticTexture,
    selectedQuantity: ctx.selectedQuantity ?? null,
    sliceApiFeatureEnabled,
    sliceTopologyReady: femSliceTopologyReady,
  });
  const vectorGlyphDataNeeded = bridgeActivity.glyphVectorDataNeeded;
  const shaderFieldDataNeeded = bridgeActivity.shaderFieldDataNeeded;

  /* ── 3D vector glyph model: arrows only, with glyph-density controls. ── */
  const viewport3DVectorField = useViewport3DVectorFieldModel({
    quantityId: viewport3DFieldRoles.glyphQuantityId,
    fieldRevision: vectorFieldRevision,
    domainGenerationId: vectorDomainGenerationId,
    adapterPointCount: glyphVectorAdapterPointCount,
    colorComponent:
      ctx.effectiveVectorComponent === "magnitude" ? "|v|" : ctx.effectiveVectorComponent,
    vectorsVisible: vectorGlyphDataNeeded,
    vectorCapabilityEnabled,
    unsupportedReason: null,
    quantityComponentCount: glyphQuantityDescriptor?.n_comp ?? null,
    everyN: ctx.requestedPreviewEveryN,
    maxGlyphs: ctx.requestedPreviewMaxPoints,
    scope: glyphVectorFetchScope,
    auditRole: "glyph",
  });
  /* ── 3D shader field model: dense field data for mesh coloring/texture. ── */
  const viewport3DShaderField = useViewport3DVectorFieldModel({
    quantityId: viewport3DFieldRoles.shaderQuantityId,
    fieldRevision: vectorFieldRevision,
    domainGenerationId: vectorDomainGenerationId,
    adapterPointCount: shaderVectorAdapterPointCount,
    colorComponent:
      ctx.effectiveVectorComponent === "magnitude" ? "|v|" : ctx.effectiveVectorComponent,
    vectorsVisible: shaderFieldDataNeeded,
    vectorCapabilityEnabled,
    unsupportedReason: null,
    quantityComponentCount: shaderQuantityDescriptor?.n_comp ?? null,
    everyN: 1,
    maxGlyphs: null,
    scope: shaderVectorFetchScope,
    auditRole: "shader",
  });
  const hasVectorData = Boolean(
    (ctx.selectedVectors && ctx.selectedVectors.length > 0) ||
      (viewport3DVectorField.data && viewport3DVectorField.data.values.length > 0) ||
      (viewport3DShaderField.data && viewport3DShaderField.data.values.length > 0),
  );

  /* ── Texture / selection derivation ── */
  const selectedMagnetizationAsset = useMemo(() => {
    if (!ctx.sceneDocument || !viewportSelectedObjectId) return null;
    const obj = ctx.sceneDocument.objects.find(
      (o) => o.id === viewportSelectedObjectId || o.name === viewportSelectedObjectId,
    );
    if (!obj) return null;
    return ctx.sceneDocument.magnetization_assets.find((a) => a.id === obj.magnetization_ref) ?? null;
  }, [ctx.sceneDocument, viewportSelectedObjectId]);

  const selectedSceneObject = useMemo(() => {
    if (!ctx.sceneDocument || !viewportSelectedObjectId) return null;
    return (
      ctx.sceneDocument.objects.find(
        (o) => o.id === viewportSelectedObjectId || o.name === viewportSelectedObjectId,
      ) ?? null
    );
  }, [ctx.sceneDocument, viewportSelectedObjectId]);

  const activeTextureMappingSpace =
    selectedMagnetizationAsset?.mapping?.space === "world" ? "world" : "object";
  const localTextureTransform = useMemo(
    () =>
      selectedMagnetizationAsset?.kind === "preset_texture"
        ? toPreviewTextureTransform(selectedMagnetizationAsset.texture_transform)
        : null,
    [selectedMagnetizationAsset],
  );
  const selectedObjectTransform = useMemo(() => {
    if (!selectedSceneObject) {
      return {
        translation: [0, 0, 0] as Vec3,
        rotation_quat: [0, 0, 0, 1] as Quat,
        scale: [1, 1, 1] as Vec3,
      };
    }
    return {
      translation: [...selectedSceneObject.transform.translation] as Vec3,
      rotation_quat: [...selectedSceneObject.transform.rotation_quat] as Quat,
      scale: [...selectedSceneObject.transform.scale] as Vec3,
    };
  }, [selectedSceneObject]);

  const activeTextureTransform =
    selectedMagnetizationAsset?.kind === "preset_texture" &&
    ctx.activeTransformScope === "texture"
      ? (() => {
          const base =
            localTextureTransform ??
            toPreviewTextureTransform(selectedMagnetizationAsset.texture_transform);
          if (activeTextureMappingSpace !== "object") return base;
          return textureTransformToWorld(base, selectedObjectTransform);
        })()
      : null;

  const activeTexturePreviewProxy =
    selectedMagnetizationAsset?.preset_kind
      ? (
          MAGNETIC_PRESET_CATALOG.find(
            (d) => d.kind === selectedMagnetizationAsset.preset_kind,
          )?.previewProxy ?? "box"
        )
      : "box";

  const activeTextureGizmoMode: TextureGizmoMode =
    ctx.sceneDocument?.editor.gizmo_mode === "rotate"
      ? "rotate"
      : ctx.sceneDocument?.editor.gizmo_mode === "scale"
        ? "scale"
        : "translate";

  const setSceneDocument = ctx.setSceneDocument;
  const applyTextureTransform = useCallback(
    (next: PreviewTextureTransform3D) => {
      if (!viewportSelectedObjectId) return;
      setSceneDocument((previousScene) => {
        if (!previousScene) return previousScene;
        const obj = previousScene.objects.find(
          (o) => o.id === viewportSelectedObjectId || o.name === viewportSelectedObjectId,
        );
        if (!obj) return previousScene;
        const mag = previousScene.magnetization_assets.find(
          (a) => a.id === obj.magnetization_ref,
        );
        if (!mag) return previousScene;
        const mappingSpace = mag.mapping?.space === "world" ? "world" : "object";
        const nextLocalTransform =
          mappingSpace === "world"
            ? next
            : textureTransformToLocal(next, {
                translation: [...obj.transform.translation] as Vec3,
                rotation_quat: [...obj.transform.rotation_quat] as Quat,
                scale: [...obj.transform.scale] as Vec3,
              });
        const normalizedTransform =
          mag.kind === "preset_texture" && mag.preset_kind === "vortex"
            ? { ...nextLocalTransform, pivot: [0, 0, 0] as Vec3 }
            : nextLocalTransform;
        return {
          ...previousScene,
          magnetization_assets: previousScene.magnetization_assets.map((a) =>
            a.id === obj.magnetization_ref
              ? { ...a, texture_transform: toSceneTextureTransform(normalizedTransform) }
              : a,
          ),
          editor: { ...previousScene.editor, active_transform_scope: "texture" },
        };
      });
    },
    [setSceneDocument, viewportSelectedObjectId],
  );

  /* ── Object select callback ── */
  const handleRequestObjectSelect = useCallback(
    (objectId: string) => {
      setSelectedObjectId(objectId);
      setSelectedSidebarNodeId(`obj-${objectId}`);
    },
    [setSelectedObjectId, setSelectedSidebarNodeId],
  );

  /* ── Antenna / overlays ── */
  const selectedAntennaName = resolveAntennaNodeName(
    selection.selectedSidebarNodeId,
    ctx.scriptBuilderCurrentModules.map((m) => m.name),
  );
  const visibleObjectIds = useMemo(
    () =>
      (ctx.sceneDocument?.objects ?? [])
        .filter((o) => o.visible !== false)
        .map((o) => o.name || o.id)
        .filter((id) => id.length > 0),
    [ctx.sceneDocument?.objects],
  );
  const antennaPreviewBadgeVisible =
    ctx.antennaOverlays.length > 0 &&
    (ctx.requestedPreviewQuantity === "H_ant" || selectedAntennaName != null);
  const selectedFemObjectId = viewportSelectedObjectId;
  const selectedObjectOverlay = useMemo(
    () =>
      selectedFemObjectId
        ? ctx.objectOverlays.find((o) => o.id === selectedFemObjectId) ?? null
        : null,
    [ctx.objectOverlays, selectedFemObjectId],
  );

  /* ── Gizmo debug ── */
  const gizmoDiagnosticSignatureRef = useRef<string>("");
  useEffect(() => {
    if (!DEBUG_GIZMO_SYNC || !selectedSceneObject) return;
    const signature = JSON.stringify({
      objectId: selectedSceneObject.id,
      activeTransformScope: ctx.activeTransformScope,
      mappingSpace: activeTextureMappingSpace,
      objectTransform: selectedObjectTransform,
      localTextureTransform,
      activeTextureTransform,
      selectedObjectOverlay,
    });
    if (signature === gizmoDiagnosticSignatureRef.current) return;
    gizmoDiagnosticSignatureRef.current = signature;
    writeFrontendDiagnosticConsole(
      "groupCollapsed",
      `[GizmoSync] viewport object=${selectedSceneObject.name || selectedSceneObject.id} scope=${ctx.activeTransformScope ?? "none"}`,
    );
    writeFrontendDiagnosticConsole("log", "scene object transform", summarizeTransform(selectedObjectTransform));
    if (selectedObjectOverlay) writeFrontendDiagnosticConsole("log", "selected overlay anchor", selectedObjectOverlay);
    else writeFrontendDiagnosticConsole("log", "selected overlay anchor", null);
    if (localTextureTransform) {
      writeFrontendDiagnosticConsole("log", "texture transform in authoring space", {
        mapping_space: activeTextureMappingSpace,
        ...summarizeTransform(localTextureTransform),
        pivot: localTextureTransform.pivot,
      });
    }
    if (activeTextureTransform) {
      writeFrontendDiagnosticConsole("log", "texture transform resolved for gizmo/world space", {
        ...summarizeTransform(activeTextureTransform),
        pivot: activeTextureTransform.pivot,
      });
    }
    if (hasMeaningfulRotation(selectedObjectTransform.rotation_quat)) {
      console.warn(
        "[GizmoSync] selected object has non-identity rotation_quat, but current viewport overlays are bounds-driven and axis-aligned.",
      );
    }
    writeFrontendDiagnosticConsole("groupEnd");
  }, [
    activeTextureMappingSpace,
    activeTextureTransform,
    ctx.activeTransformScope,
    localTextureTransform,
    selectedObjectOverlay,
    selectedObjectTransform,
    selectedSceneObject,
  ]);

  /* ── Object overlays ── */
  const displayObjectOverlays = useMemo(() => {
    if (femDiscretization && ctx.meshParts.length > 0) {
      return ctx.objectOverlays.filter((o) =>
        ctx.visibleMagneticObjectIds.includes(o.id),
      );
    }
    return ctx.objectOverlays.filter((o) => visibleObjectIds.includes(o.id));
  }, [
    ctx.meshParts.length,
    ctx.objectOverlays,
    ctx.visibleMagneticObjectIds,
    femDiscretization,
    visibleObjectIds,
  ]);

  const renderPlan = ctx.resolvedRenderPlan;
  const effectiveSlicePlane = renderPlan?.slice
    ? planeFromSliceAxis(renderPlan.slice.axis)
    : ctx.plane;

  /* ── FEM layer state ── */
  const femLayerState = renderPlan?.layers.femLayers ?? viz.femViewportLayers;
  const geometryAuthoringShowPrimitives = showGeometryAuthoringViewport
    ? true
    : femLayerState.showPrimitives;
  const geometryAuthoringShowMesh = showGeometryAuthoringViewport
    ? false
    : femLayerState.showMesh;
  const geometryAuthoringShowQuantity = showGeometryAuthoringViewport
    ? false
    : femLayerState.showQuantity;
  const geometryModeObjectOverlays = useMemo(
    () => {
      if (!geometryAuthoringShowPrimitives) return [];
      if (femDiscretization) {
        return ctx.objectOverlays;
      }
      return ctx.objectOverlays.filter((o) => visibleObjectIds.includes(o.id));
    },
    [
      ctx.objectOverlays,
      femDiscretization,
      geometryAuthoringShowPrimitives,
      visibleObjectIds,
    ],
  );
  const geometryAuthoringMeshStatus = useMemo(() => {
    if (!geometryAuthoringShowMesh) return "hidden";
    if (!builderGeometryRealization) return "no-geometry";
    if (!builderMeshSnapshot) return "no-mesh";
    if (builderMeshSnapshot.meshState !== "ready") return "failed";
    if (
      builderMeshSnapshot.sourceGeometryRevision !== builderGeometryRealization.revision ||
      builderMeshDirty
    ) return "stale";
    return "current";
  }, [
    builderGeometryRealization,
    builderMeshDirty,
    builderMeshSnapshot,
    geometryAuthoringShowMesh,
  ]);
  const femLayerRenderState = useMemo(
    () =>
      deriveFemLayerRenderState({
        layers: femLayerState,
        objectOverlays: displayObjectOverlays,
        meshOpacity: renderPlan?.layers.meshOpacityPercent ?? viz.meshOpacity,
        colorField: ctx.femColorField,
        magneticTextureColorField: resolveMagneticTextureColorField({
          showMagneticTexture: femLayerState.showMagneticTexture,
        }),
        showArrows: renderPlan?.layers.vectorsVisible ?? vectorViz.showArrows,
      }),
    [
      ctx.femColorField,
      viz.meshOpacity,
      vectorViz.showArrows,
      ctx.selectedQuantity,
      displayObjectOverlays,
      femLayerState,
      renderPlan?.layers.meshOpacityPercent,
      renderPlan?.layers.vectorsVisible,
    ],
  );
  const femObjectOverlaysForRender = femLayerRenderState.objectOverlays;
  const femOpacityForRender = femLayerRenderState.meshOpacity;
  const femMagneticColorFieldForRender = femLayerRenderState.magneticColorField;
  const femAirColorFieldForRender = femLayerRenderState.airColorField;
  const femColorFieldForRender = femMagneticColorFieldForRender;
  const femShowArrowsForRender = femLayerRenderState.showArrows;

  const effectiveFemMeshEntityViewState = useMemo(() => {
    if (!femDiscretization || ctx.meshParts.length === 0) return ctx.meshEntityViewState;
    if (renderPlan) {
      return resolveEffectiveFemMeshEntityViewStateFromRenderPlan({
        plan: renderPlan,
        meshParts: ctx.meshParts,
        meshEntityViewState: ctx.meshEntityViewState,
        fallbackMeshRenderMode: viz.meshRenderMode,
        fallbackMeshOpacity: viz.meshOpacity,
        fallbackSelectedQuantity: ctx.selectedQuantity,
      });
    }
    const next: MeshEntityViewStateMap = { ...ctx.meshEntityViewState };
    const resolvedGlobalMeshRenderMode: MeshEntityViewState["renderMode"] =
      viz.meshRenderMode === "wireframe" || viz.meshRenderMode === "surface+edges"
        || viz.meshRenderMode === "surface"
        || viz.meshRenderMode === "points"
        || viz.meshRenderMode === "mesh"
        ? viz.meshRenderMode
        : "surface";
    for (const part of ctx.meshParts) {
      const current = next[part.id] ?? defaultMeshEntityViewState(part);
      const airboxScoped = part.role === "air" || part.role === "outer_boundary";
      const hasExplicitState = Object.prototype.hasOwnProperty.call(next, part.id);
      const baseRenderMode = airboxScoped
        ? resolveEffectiveMeshEntityRenderMode({ currentRenderMode: current.renderMode })
        : hasExplicitState
          ? resolveEffectiveMeshEntityRenderMode({ currentRenderMode: current.renderMode })
          : resolvedGlobalMeshRenderMode;
      let effectiveRenderMode = baseRenderMode === "surface" && femLayerState.showMesh
        ? "surface+edges"
        : baseRenderMode === "surface+edges" && !femLayerState.showMesh
          ? "surface"
          : baseRenderMode;
      let geometryVisible = current.geometryVisible;
      if (!airboxScoped && !femLayerState.showPrimitives) {
        if (effectiveRenderMode === "surface+edges" || effectiveRenderMode === "mesh") {
          effectiveRenderMode = "wireframe";
        } else if (effectiveRenderMode === "surface") {
          geometryVisible = false;
        }
      }
      next[part.id] = {
        ...current,
        renderMode: effectiveRenderMode,
        geometryVisible,
        opacity: airboxScoped
          ? current.opacity
          : hasExplicitState
            ? current.opacity
            : viz.meshOpacity,
        colorField:
          part.role === "magnetic_object"
            ? femLayerState.showQuantity
              ? current.colorField
              : femLayerState.showMagneticTexture
                ? ctx.selectedQuantity === "m"
                  ? "orientation"
                  : "none"
                : "none"
            : "none",
      };
    }
    return next;
  }, [
    ctx.meshEntityViewState,
    viz.meshOpacity,
    ctx.meshParts,
    viz.meshRenderMode,
    ctx.selectedQuantity,
    femDiscretization,
    femLayerState.showMesh,
    femLayerState.showMagneticTexture,
    femLayerState.showPrimitives,
    femLayerState.showQuantity,
    renderPlan,
  ]);

  const patchMeshPartViewState = useCallback(
    (partIds: string[], patch: Partial<MeshEntityViewStateMap[string]>) => {
      if (partIds.length === 0) return;
      setMeshEntityViewState((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const partId of partIds) {
          const part = meshParts.find((c) => c.id === partId);
          const current = next[partId] ?? (part ? defaultMeshEntityViewState(part) : null);
          if (!current) continue;
          const updated = { ...current, ...patch };
          if (
            !next[partId] ||
            updated.visible !== current.visible ||
            updated.renderMode !== current.renderMode ||
            updated.opacity !== current.opacity ||
            updated.colorField !== current.colorField
          ) {
            next[partId] = updated;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [meshParts, setMeshEntityViewState],
  );

  const openSelectedSubmeshesToolbox = useCallback(() => {
    setRightInspectorOpen(true);
    setRightInspectorTab("selected-submeshes");
  }, [setRightInspectorOpen, setRightInspectorTab]);
  const selectedSubmeshesToolboxOpen =
    rightInspectorOpen && rightInspectorTab === "selected-submeshes";

  /* ── Submesh snapshot cleanup ── */
  const setVisibleSubmeshSnapshot = ctx.setVisibleSubmeshSnapshot;
  const visibleSubmeshSnapshot = ctx.visibleSubmeshSnapshot;
  useEffect(() => {
    const femSubmeshViewportActive =
      Boolean(femMeshData) &&
      (effectiveViewMode === "3D" || effectiveViewMode === "Mesh");
    if (femSubmeshViewportActive) return;
    if (visibleSubmeshSnapshot != null) setVisibleSubmeshSnapshot(null);
  }, [effectiveViewMode, femMeshData, setVisibleSubmeshSnapshot, visibleSubmeshSnapshot]);

  /* ── Quantity options ── */
  const femQuantityOptions = useMemo(
    () =>
      ctx.previewQuantityOptions.map((option) => {
        const qty = ctx.quantities.find((q) => q.id === option.value);
        return {
          id: option.value,
          shortLabel: qty?.quick_access_label ?? option.value,
          label: option.label,
          available: !option.disabled,
        };
      }),
    [ctx.previewQuantityOptions, ctx.quantities],
  );

  /* ── Slice callbacks ── */
  const patchDisplay = ctx.patchDisplay;
  const setComponent = ctx.setComponent;
  const previewControlsActive = ctx.previewControlsActive;

  const handlePreviewMaxPointsChange = useCallback(
    (nextMaxPoints: number) => void patchDisplay({ max_points: nextMaxPoints }),
    [patchDisplay],
  );

  const handleFemSliceComponentChange = useCallback(
    (nextComponent: "x" | "y" | "z" | "magnitude") => {
      if (previewControlsActive) {
        void patchDisplay(
          displayPatchFromPreviewComponentOnly(nextComponent === "magnitude" ? "3D" : nextComponent),
        );
        return;
      }
      setComponent(nextComponent);
    },
    [previewControlsActive, setComponent, patchDisplay],
  );

  const handleSlice2DToolbarChange = useCallback(
    (patch: Partial<Slice2DModel["toolbar"]>) => {
      patchSlice2DToolbar(patch);
      if (patch.quantityId) requestDisplayQuantity(patch.quantityId);
      if (patch.component) handleFemSliceComponentChange(patch.component);
      if (patch.axis) {
        const nextSliceAxis = resolveSliceAxisSelection({
          axis: patch.axis,
          syncClipAxis: Boolean(femDiscretization),
        });
        setPlane(nextSliceAxis.plane);
      }
      if (patch.mode) {
        void patchDisplay({ slice_mode: patch.mode === "all_layers" ? "all" : patch.mode });
      }
      if (typeof patch.layerIndex === "number") {
        setSliceIndex(patch.layerIndex);
        void patchDisplay({ slice_layer: patch.layerIndex });
      }
      if (typeof patch.positionPercent === "number") {
        const nextSliceIndex = sliceIndexFromPositionPercent({
          grid: ctx.previewGrid,
          plane: effectiveSlicePlane,
          positionPercent: patch.positionPercent,
        });
        setSliceIndex(nextSliceIndex);
        void patchDisplay({ slice_layer: nextSliceIndex });
      }
      if (patch.colormap) void patchDisplay({ colormap: patch.colormap });
      if (typeof patch.autoContrast === "boolean") {
        void patchDisplay({ auto_contrast: patch.autoContrast });
      }
      if (typeof patch.showVectors === "boolean") {
        void patchDisplay({
          layers: {
            vectors: {
              visible: patch.showVectors,
            },
          },
        });
        if (!patch.showVectors && femLayerState.showMagneticTexture && !femLayerState.showQuantity) {
          ctx.requestPreviewQuantity("m");
        }
      }
      if (typeof patch.showPrimitives === "boolean") {
        void patchDisplay(visualizationPatchForFemLayers({
          ...femLayerState,
          showPrimitives: patch.showPrimitives,
        }));
      }
      if (typeof patch.showMesh === "boolean") {
        void patchDisplay(visualizationPatchForFemLayers({
          ...femLayerState,
          showMesh: patch.showMesh,
        }));
      }
      if (typeof patch.showMagneticTexture === "boolean") {
        void patchDisplay(visualizationPatchForFemLayers({
          ...femLayerState,
          showMagneticTexture: patch.showMagneticTexture,
          showQuantity: patch.showMagneticTexture ? false : femLayerState.showQuantity,
        }));
        if (patch.showMagneticTexture) {
          ctx.requestPreviewQuantity("m");
        }
      }
      if (typeof patch.showQuantity === "boolean") {
        void patchDisplay(visualizationPatchForFemLayers({
          ...femLayerState,
          showQuantity: patch.showQuantity,
          showMagneticTexture: patch.showQuantity ? false : femLayerState.showMagneticTexture,
        }));
      }
    },
    [
      ctx,
      femLayerState.showMesh,
      femLayerState.showMagneticTexture,
      femLayerState.showPrimitives,
      femLayerState.showQuantity,
      handleFemSliceComponentChange,
      patchDisplay,
      patchSlice2DToolbar,
      requestDisplayQuantity,
      setPlane,
      setSliceIndex,
      femDiscretization,
      effectiveSlicePlane,
    ],
  );

  /* ── Exact scope missing check ── */
  const hasExactScopeSegment = useMemo(() => {
    if (!selectedFemObjectId) return false;
    const parts = ctx.effectiveFemMesh?.mesh_parts ?? [];
    if (parts.length > 0) {
      return parts.some(
        (p) => p.role === "magnetic_object" && p.object_id === selectedFemObjectId,
      );
    }
    return (ctx.effectiveFemMesh?.object_segments ?? []).some(
      (s) => s.object_id === selectedFemObjectId,
    );
  }, [ctx.effectiveFemMesh?.mesh_parts, ctx.effectiveFemMesh?.object_segments, selectedFemObjectId]);

  const missingExactScopeSegment =
    Boolean(femDiscretization) &&
    shouldFlagMissingExactScopeSegment({
      selectedObjectId: selectedFemObjectId,
      selectedObjectOverlayFidelity: selectedObjectOverlay?.fidelity ?? null,
      nElements: ctx.femMeshData?.nElements ?? 0,
      hasExactScopeSegment,
    });

  /* ── Scale factor ── */
  const originalUnit = ctx.quantityDescriptor?.unit;
  const isAmField = originalUnit === "A/m";
  const scaleFactor = isAmField ? 4 * Math.PI * 1e-7 : 1.0;

  /* ── Scaled preview data ── */
  const scaledGlobalScalarPreview = useMemo(() => {
    if (!globalScalarPreview || scaleFactor === 1.0) return globalScalarPreview;
    return { ...globalScalarPreview, value: globalScalarPreview.value * scaleFactor, unit: "T" };
  }, [globalScalarPreview, scaleFactor]);

  const scaledSpatialPreview = useMemo(() => {
    if (
      !spatialPreview ||
      spatialPreview.spatial_kind !== "grid" ||
      spatialPreview.type !== "2D" ||
      scaleFactor === 1.0
    ) return spatialPreview;
    return {
      ...spatialPreview,
      unit: "T",
      min: spatialPreview.min * scaleFactor,
      max: spatialPreview.max * scaleFactor,
      scalar_field: spatialPreview.scalar_field.map(
        ([x, y, v]) => [x, y, v * scaleFactor] as [number, number, number],
      ),
    };
  }, [spatialPreview, scaleFactor]);

  const scaledVectors = useMemo(() => {
    return measureFrontendAudit("scaledVectors", () => {
      return ctx.selectedVectors;
    });
  }, [ctx.selectedVectors]);

  const scaledFetched3DVectors = useMemo(() => {
    return measureFrontendAudit("scaledFetched3DVectors", () => {
      if (!bridgeActivity.data3DActive) return null;
      if (viewport3DVectorField.status !== "ready") return null;
      const values = viewport3DVectorField.data?.values ?? null;
      if (!values) return null;
      return values;
    });
  }, [
    bridgeActivity.data3DActive,
    viewport3DVectorField.data,
    viewport3DVectorField.status,
  ]);

  /* ── Slice 2D params ── */
  const shouldUseSliceApi2D = bridgeActivity.slice2DActive;
  const sliceSampling = useMemo(
    () => deriveSliceSampling(ctx.previewGrid, effectiveSlicePlane, ctx.sliceIndex),
    [ctx.previewGrid, ctx.sliceIndex, effectiveSlicePlane],
  );
  const sliceFieldRevision = resolveSlice2DFieldRevision({
    runtimeResourceRevisions,
    fieldDataRevision: ctx.fieldDataRevision,
    liveFieldSourceStep: ctx.liveFieldSourceStep,
    effectiveStep: ctx.effectiveStep,
  });
  const sliceQuantityId = scaledSpatialPreview?.quantity ?? ctx.selectedQuantity;
  const sliceComponent = ctx.component;

  const unifiedSliceDisplaySelection = useMemo<DisplaySelection>(
    () => ({
      active_quantity_id: String(renderPlan?.slice.quantityId ?? sliceQuantityId ?? ctx.selectedQuantity),
      view_mode: "2d",
      field_component: renderPlan?.slice.component ?? toDisplayFieldComponent(sliceComponent),
      colormap: renderPlan?.slice.colormap ?? "viridis",
      auto_contrast: renderPlan?.slice.autoContrast ?? ctx.requestedPreviewAutoScale,
      contrast_min: null,
      contrast_max: null,
      vector_glyphs: renderPlan?.slice.showVectors ?? vectorViz.showArrows,
      vector_density: ctx.requestedPreviewEveryN,
      slice_mode: renderPlan?.slice.mode ?? (ctx.requestedPreviewAllLayers ? "all_layers" : "single"),
      slice_layer: renderPlan?.slice.layerIndex ?? ctx.sliceIndex,
      max_points: ctx.requestedPreviewMaxPoints,
      x_chosen_size: ctx.requestedPreviewXChosenSize,
      y_chosen_size: ctx.requestedPreviewYChosenSize,
    }),
    [
      vectorViz.showArrows,
      ctx.requestedPreviewAllLayers,
      ctx.requestedPreviewAutoScale,
      ctx.requestedPreviewEveryN,
      ctx.requestedPreviewMaxPoints,
      ctx.requestedPreviewXChosenSize,
      ctx.requestedPreviewYChosenSize,
      ctx.selectedQuantity,
      ctx.sliceIndex,
      renderPlan?.slice,
      sliceComponent,
      sliceQuantityId,
    ],
  );

  const slice2DPlaneOptions = useMemo(
    () => ({
      axis: renderPlan?.slice.axis ?? sliceAxisFromPlane(effectiveSlicePlane),
      positionPercent: renderPlan?.slice.positionPercent ?? (femDiscretization
        ? (viz.meshClipPos ?? 50)
        : sliceSampling.cutNorm * 100),
    }),
    [viz.meshClipPos, effectiveSlicePlane, femDiscretization, renderPlan?.slice, sliceSampling.cutNorm],
  );

  const slice2DBaseModel = useSlice2DModel({
    display: unifiedSliceDisplaySelection,
    resources: runtimeResourceRevisions,
    capabilities: ctx.domainCapabilities,
    adapterKind: femDiscretization ? "fem" : "fdm",
    planeOptions: slice2DPlaneOptions,
  });

  const slice2DModel = useMemo<Slice2DModel>(() => {
    const localProjectionPatch: Partial<Slice2DModel["toolbar"]> = {};
    if (slice2DToolbarPatch.projectionReduction) {
      localProjectionPatch.projectionReduction = slice2DToolbarPatch.projectionReduction;
    }
    if (typeof slice2DToolbarPatch.projectionIncludeAirAsZero === "boolean") {
      localProjectionPatch.projectionIncludeAirAsZero =
        slice2DToolbarPatch.projectionIncludeAirAsZero;
    }
    if (typeof slice2DToolbarPatch.projectionSamples === "number") {
      localProjectionPatch.projectionSamples = slice2DToolbarPatch.projectionSamples;
    }
    if (typeof slice2DToolbarPatch.projectionResolution === "number") {
      localProjectionPatch.projectionResolution = slice2DToolbarPatch.projectionResolution;
    }
    if (typeof slice2DToolbarPatch.positionPercent === "number") {
      localProjectionPatch.positionPercent = slice2DToolbarPatch.positionPercent;
    }
    if (typeof slice2DToolbarPatch.showAirbox === "boolean") {
      localProjectionPatch.showAirbox = slice2DToolbarPatch.showAirbox;
    }
    if (slice2DToolbarPatch.airboxRenderMode) {
      localProjectionPatch.airboxRenderMode = slice2DToolbarPatch.airboxRenderMode;
    }
    if (typeof slice2DToolbarPatch.showAirboxVectors === "boolean") {
      localProjectionPatch.showAirboxVectors = slice2DToolbarPatch.showAirboxVectors;
    }
    const layerControlledToolbar = femDiscretization
        ? {
          ...slice2DBaseModel.toolbar,
          showPrimitives: viz.femViewportLayers.showPrimitives,
          showMesh: viz.femViewportLayers.showMesh,
          showMagneticTexture: viz.femViewportLayers.showMagneticTexture,
          showQuantity: viz.femViewportLayers.showQuantity,
        }
      : slice2DBaseModel.toolbar;
    const toolbar = renderPlan?.slice
      ? { ...renderPlan.slice, ...localProjectionPatch }
      : { ...layerControlledToolbar, ...slice2DToolbarPatch };
    const rebuiltFrame = rebuildSlice2DModelFrame({
      base: slice2DBaseModel,
      toolbar,
      adapterKind: femDiscretization ? "fem" : "fdm",
    });
    return {
      ...slice2DBaseModel,
      toolbar,
      render: rebuiltFrame.render,
      diagnostics: rebuiltFrame.diagnostics,
      overlays: {
        ...slice2DBaseModel.overlays,
        showPrimitives: toolbar.showPrimitives,
        showMesh: toolbar.showMesh,
        showMagneticTexture: toolbar.showMagneticTexture,
        showAirbox: toolbar.showAirbox,
        showQuantity: toolbar.showQuantity,
        showVectors: toolbar.showVectors,
      },
    };
  }, [viz.femViewportLayers, femDiscretization, renderPlan?.slice, slice2DBaseModel, slice2DToolbarPatch]);

  const field2DRequestState = useMemo(
    () =>
      resolveSlice2DFieldRequestState({
        enabled: shouldUseSliceApi2D,
        model: slice2DModel,
      }),
    [shouldUseSliceApi2D, slice2DModel],
  );

  const field2DRequest = useMemo<Field2DResourceRequest | null>(() => {
    if (!field2DRequestState.query || !field2DRequestState.kind) {
      return null;
    }
    return {
      kind: field2DRequestState.kind,
      query: field2DRequestState.query,
    } as Field2DResourceRequest;
  }, [field2DRequestState]);

  const field2DUnsupportedReason = field2DRequestState.unsupportedReason;

  const shouldUseBackendSlice2D = Boolean(field2DRequest);

  const slice2D = useField2DResource(
    shouldUseSliceApi2D ? sliceQuantityId : null,
    shouldUseSliceApi2D ? sliceFieldRevision : null,
    runtimeResourceRevisions?.domain_generation_id ?? 0,
    field2DRequest,
    field2DUnsupportedReason,
  );

  const scaledSliceScalar = useMemo(() => {
    return measureFrontendAudit("scaledSliceScalar", () => {
      const scalar = slice2D.scalar;
      if (!scalar) return null;
      if (scaleFactor === 1.0) return scalar.values;
      incrementFrontendAuditCounter("typedArrayAllocations", 1);
      return Float64Array.from(scalar.values, (v) => v * scaleFactor);
    });
  }, [scaleFactor, slice2D.scalar]);

  const sliceScalarShape = useMemo<[number, number] | null>(() => {
    if (!slice2D.meta) return null;
    return [slice2D.meta.x_pixels, slice2D.meta.y_pixels];
  }, [slice2D.meta]);

  const hasSliceScalar =
    Boolean(scaledSliceScalar) &&
    Boolean(sliceScalarShape) &&
    (sliceScalarShape?.[0] ?? 0) > 0 &&
    (sliceScalarShape?.[1] ?? 0) > 0;

  /* ── Debug render data ── */
  const liveRenderDebugData = useMemo(
    () =>
      buildVectorLiveRenderDebugData({
        source: ctx.selectedVectorSourceKind,
        fieldDataRevision: ctx.fieldDataRevision,
        fieldDataTimestamp: ctx.fieldDataTimestamp,
        liveFieldSourceStep: ctx.liveFieldSourceStep,
        previewSourceStep: ctx.previewSourceStep,
        effectiveStep: ctx.effectiveStep,
      }),
    [
      ctx.selectedVectorSourceKind,
      ctx.fieldDataRevision,
      ctx.fieldDataTimestamp,
      ctx.liveFieldSourceStep,
      ctx.previewSourceStep,
      ctx.effectiveStep,
    ],
  );

  /* ── Scaled FEM mesh data ── */
  const femFieldData = femMeshData?.fieldData;
  const femShaderFieldData = femMeshData?.shaderFieldData;
  const scaledFemMeshData = useMemo(() => {
    return measureFrontendAudit("scaledFemMeshData", () => {
      if (!femMeshData || scaleFactor === 1.0 || !femMeshData.fieldData) return femMeshData;
      const fld = femMeshData.fieldData;
      incrementFrontendAuditCounter(
        "typedArrayAllocations",
        Number(Boolean(fld.x)) + Number(Boolean(fld.y)) + Number(Boolean(fld.z)),
      );
      return {
        ...femMeshData,
        fieldData: {
          ...fld,
          x: scaleFieldComponentForRender(fld.x, scaleFactor),
          y: scaleFieldComponentForRender(fld.y, scaleFactor),
          z: scaleFieldComponentForRender(fld.z, scaleFactor),
        },
      } as typeof femMeshData;
    });
  }, [
    femMeshData?.activeMask,
    femMeshData?.boundaryFaces,
    femMeshData?.elements,
    femMeshData?.fieldNComp,
    femMeshData?.fieldRevision,
    femFieldData?.x,
    femFieldData?.y,
    femFieldData?.z,
    femMeshData?.meshGenerationId,
    femMeshData?.nElements,
    femMeshData?.nNodes,
    femMeshData?.nodes,
    femMeshData?.quantityDomain,
    femShaderFieldData?.x,
    femShaderFieldData?.y,
    femShaderFieldData?.z,
    scaleFactor,
  ]);

  const scopedFetchedFemMeshData = useMemo(() => {
    return measureFrontendAudit("scopedFetchedFemMeshData", () => {
      if (
        !bridgeActivity.shaderFieldDataNeeded ||
        !scaledFemMeshData ||
        !femDiscretization ||
        !isViewport3DVectorFieldRenderable(viewport3DShaderField)
      ) return scaledFemMeshData;
      const shaderField = viewport3DShaderField.data;
      if (!shaderField) return scaledFemMeshData;
      const dense = buildDenseFemVectorField({
        nNodes: scaledFemMeshData.nNodes,
        meshParts: ctx.meshParts,
        frames: [{ scope: shaderVectorFetchScope, field: shaderField }],
      });
      if (!dense) return scaledFemMeshData;
      const x = new Float32Array(scaledFemMeshData.nNodes);
      const y = new Float32Array(scaledFemMeshData.nNodes);
      const z = new Float32Array(scaledFemMeshData.nNodes);
      incrementFrontendAuditCounter("typedArrayAllocations", 3);
      for (let i = 0; i < scaledFemMeshData.nNodes; i++) {
        x[i] = (dense.values[i * 3] ?? 0) * scaleFactor;
        y[i] = (dense.values[i * 3 + 1] ?? 0) * scaleFactor;
        z[i] = (dense.values[i * 3 + 2] ?? 0) * scaleFactor;
      }
      return {
        ...scaledFemMeshData,
        fieldData: { x, y, z },
        fieldNComp: dense.nComp,
        activeMask: dense.activeMask,
        fieldRevision: viewport3DShaderField.fieldRevision ?? scaledFemMeshData.fieldRevision,
      };
    });
  }, [
    bridgeActivity.shaderFieldDataNeeded,
    ctx.meshParts,
    femDiscretization,
    scaleFactor,
    scaledFemMeshData,
    shaderVectorFetchScope,
    viewport3DShaderField.data,
    viewport3DShaderField.fieldRevision,
    viewport3DShaderField.status,
  ]);

  const shaderDownsampledFemMeshData = useMemo(() => {
    return measureFrontendAudit("downsampleVectorFieldSpatialBins", () => {
      if (!bridgeActivity.data3DActive || !bridgeActivity.shaderFieldDataNeeded) {
        return scopedFetchedFemMeshData;
      }
      if (!scopedFetchedFemMeshData?.fieldData) return scopedFetchedFemMeshData;
      return {
        ...scopedFetchedFemMeshData,
        shaderFieldData: downsampleVectorFieldSpatialBins({
          nodes: scopedFetchedFemMeshData.nodes,
          nNodes: scopedFetchedFemMeshData.nNodes,
          fieldData: scopedFetchedFemMeshData.fieldData,
          targetBins: viz.femTextureDownsampleCells,
        }),
      };
    });
  }, [
    bridgeActivity.data3DActive,
    bridgeActivity.shaderFieldDataNeeded,
    viz.femTextureDownsampleCells,
    scopedFetchedFemMeshData,
  ]);

  const renderFemMeshData = shaderDownsampledFemMeshData ?? scopedFetchedFemMeshData;

  const resolvedFemTopologyKey = useMemo(() => {
    const explicit = ctx.femTopologyKey?.trim();
    if (explicit) return explicit;
    const gen = scaledFemMeshData?.meshGenerationId?.trim();
    if (gen) return `gen:${gen}`;
    return null;
  }, [ctx.femTopologyKey, scaledFemMeshData?.meshGenerationId]);

  const viewportFitSeed = useMemo(
    () =>
      buildViewportFitSeed({
        resolvedFemTopologyKey,
        scaledFemMeshData,
      }),
    [
      resolvedFemTopologyKey,
      scaledFemMeshData?.boundaryFaces?.length,
      scaledFemMeshData?.nElements,
      scaledFemMeshData?.nNodes,
    ],
  );

  /* ── Viewport route determination ── */
  const isVectorSurface3DActive =
    ctx.effectiveViewMode === "3D" &&
    !femDiscretization &&
    (ctx.isVectorQuantity || hasVectorData) &&
    !globalScalarPreview;
  const isVectorSurfaceMeshActive =
    false;
  const showVectorSurface3D =
    !showGeometryAuthoringViewport &&
    (isVectorSurface3DActive || isVectorSurfaceMeshActive);
  const vectorSurfaceFieldLabel =
    isVectorSurfaceMeshActive
      ? "Geometry"
      : (ctx.quantityDescriptor?.label ?? scaledSpatialPreview?.quantity ?? ctx.selectedQuantity);
  const vectorSurfaceVectors = isVectorSurface3DActive
    ? (scaledFetched3DVectors ?? scaledVectors)
    : null;

  const handleVectorSurfaceTransformScopeChange = useCallback(
    (scope: "object" | "texture" | null) => ctx.setActiveTransformScope(scope),
    [ctx.setActiveTransformScope],
  );

  const vectorSurfaceSharedProps = useMemo(
    () => ({
      grid: ctx.previewGrid,
      fieldLabel: vectorSurfaceFieldLabel,
      liveRenderDebugData,
      geometryMode: isVectorSurfaceMeshActive,
      activeMask: ctx.activeMask,
      worldExtent: ctx.worldExtent,
      objectOverlays: ctx.objectOverlays,
      selectedObjectId: viewportSelectedObjectId,
      universeCenter: ctx.worldCenter,
      focusObjectRequest: selection.focusObjectRequest,
      objectViewMode: ctx.objectViewMode,
      settings: fdmVisualizationSettings,
      vectorValueScale: scaleFactor,
      onSettingsChange: setFdmVisualizationSettingsAction,
      onAntennaTranslate: ctx.applyAntennaTranslation,
      onGeometryTranslate: ctx.applyGeometryTranslation,
      onRequestObjectSelect: handleRequestObjectSelect,
      activeTextureTransform,
      textureGizmoMode: activeTextureGizmoMode,
      activeTexturePreviewProxy,
      onTextureTransformChange: applyTextureTransform,
      onTextureTransformCommit: applyTextureTransform,
      activeTransformScope: ctx.activeTransformScope,
      onTransformScopeChange: handleVectorSurfaceTransformScopeChange,
    }),
    [
      activeTexturePreviewProxy,
      activeTextureTransform,
      activeTextureGizmoMode,
      applyTextureTransform,
      ctx.activeMask,
      ctx.activeTransformScope,
      ctx.applyAntennaTranslation,
      ctx.applyGeometryTranslation,
      fdmVisualizationSettings,
      selection.focusObjectRequest,
      ctx.objectOverlays,
      ctx.objectViewMode,
      ctx.previewGrid,
      setFdmVisualizationSettingsAction,
      scaleFactor,
      ctx.worldCenter,
      ctx.worldExtent,
      handleVectorSurfaceTransformScopeChange,
      handleRequestObjectSelect,
      isVectorSurfaceMeshActive,
      liveRenderDebugData,
      vectorSurfaceFieldLabel,
      viewportSelectedObjectId,
    ],
  );

  /* ── Viewport 3D controller ── */
  const unifiedViewport3DEnabled =
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableUnifiedViewport3D;
  const unifiedToolbarEnabled =
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableUnifiedViewportToolbar;
  const viewport3dStages = mapRouteFlagsToViewport3DStages({
    enableUnifiedViewport3D: unifiedViewport3DEnabled,
    enableUnifiedViewportToolbar: unifiedToolbarEnabled,
  });
  const { femToolbarMode, vectorToolbarMode } = resolveViewportInternalToolbarModes({
    unifiedToolbarEnabled,
    femDiagnosticToolbarEnabled: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showToolbar,
  });
  const viewport3DInteractionMode: Viewport3DInteractionMode = geometryViewportPresetActive
    ? toViewportInteractionMode(builderViewportTool)
    : "camera";
  const viewport3DRenderState = useMemo<UnifiedRenderState>(
    () => ({
      selectedLayer: ctx.requestedPreviewLayer ?? ctx.sliceIndex,
      allLayersVisible: ctx.requestedPreviewAllLayers,
      vectorComponent: toUnifiedVectorComponent(
        ctx.effectiveViewMode === "3D" ? "3D" : ctx.requestedPreviewComponent,
      ),
      colorScale: renderPlan?.quantity.colormap ?? "viridis",
      autoScale: renderPlan?.quantity.autoContrast ?? ctx.requestedPreviewAutoScale,
      maxPoints: renderPlan?.sampling.maxPoints ?? ctx.requestedPreviewMaxPoints,
      everyN: ctx.requestedPreviewEveryN,
      meshRenderMode: toUnifiedRenderMode(renderPlan?.layers.renderMode ?? viz.meshRenderMode),
      meshOpacity: renderPlan?.layers.meshOpacityPercent ?? viz.meshOpacity,
      trim: renderPlan?.trim,
      clipEnabled: renderPlan?.clip.enabled ?? viz.meshClipEnabled,
      clipAxis: renderPlan?.clip.axis ?? viz.meshClipAxis,
      clipPosition: renderPlan?.clip.positionPercent ?? viz.meshClipPos,
      arrowColorMode: renderPlan?.vectorStyle.colorMode ?? vectorViz.colorMode,
      arrowMonoColor: renderPlan?.vectorStyle.monoColor ?? vectorViz.monoColor,
      arrowLengthScale: renderPlan?.vectorStyle.lengthScale ?? vectorViz.lengthScale,
      arrowThickness: renderPlan?.vectorStyle.thickness ?? vectorViz.thickness,
      vectorDomainFilter: renderPlan?.layers.vectorDomainFilter ?? vectorViz.domainFilter,
      ferromagnetVisibilityMode:
        renderPlan?.vectorStyle.ferromagnetVisibility ?? vectorViz.ferromagnetVisibilityMode,
      femLayers: renderPlan?.layers.femLayers ?? viz.femViewportLayers,
      renderPasses: renderPlan?.layers.passes,
      airboxPasses: renderPlan?.layers.airbox,
    }),
    [
      ctx.effectiveViewMode,
      vectorViz.colorMode,
      vectorViz.lengthScale,
      vectorViz.monoColor,
      vectorViz.thickness,
      vectorViz.ferromagnetVisibilityMode,
      viz.femViewportLayers,
      vectorViz.domainFilter,
      viz.meshClipAxis,
      viz.meshClipEnabled,
      viz.meshClipPos,
      viz.meshOpacity,
      viz.meshRenderMode,
      renderPlan,
      ctx.requestedPreviewAllLayers,
      ctx.requestedPreviewAutoScale,
      ctx.requestedPreviewComponent,
      ctx.requestedPreviewEveryN,
      ctx.requestedPreviewLayer,
      ctx.requestedPreviewMaxPoints,
      ctx.sliceIndex,
    ],
  );

  const viewport3DController = useViewport3DController({
    capabilities: ctx.domainCapabilities,
    authoringEnabled: builderEnabled,
    diagnosticsEnabled: FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging,
    renderState: viewport3DRenderState,
    resources: {
      statusResources: runtimeResourceRevisions,
      quantityId: ctx.requestedPreviewQuantity ?? null,
      component: toViewportFieldComponent(
        ctx.effectiveViewMode === "3D" ? "3D" : ctx.requestedPreviewComponent,
      ),
      selection: {
        objectId: viewportSelectedObjectId,
        partId: selection.selectedEntityId,
      },
      clip: {
        enabled: renderPlan?.clip.enabled ?? viz.meshClipEnabled,
        axis: renderPlan?.clip.axis ?? viz.meshClipAxis,
        position: renderPlan?.clip.positionPercent ?? viz.meshClipPos,
        invert: renderPlan?.clip.flipped ?? viz.meshClipFlip,
      },
      topologyFallbackRevision: resolvedFemTopologyKey,
      femMeshFieldRevision: scaledFemMeshData?.fieldRevision,
      dataPlaneFieldRevision: ctx.fieldDataRevision,
      selectedVectorCount:
        ctx.selectedVectors?.length
          ?? viewport3DVectorField.data?.values.length
          ?? viewport3DShaderField.data?.values.length
          ?? 0,
    },
    toolbar: {
      clipFlip: renderPlan?.clip.flipped ?? viz.meshClipFlip,
      interactionMode: viewport3DInteractionMode,
      snapEnabled: Boolean(builderSnapSettings.enabled),
      objectViewMode: ctx.objectViewMode,
      vectorsVisible: renderPlan?.layers.vectorsVisible ?? vectorViz.showArrows,
      legendVisible: viz.viewportLegendVisible,
      partExplorerVisible: selectedSubmeshesToolboxOpen,
      projection: graphActiveViewportCameraState?.projection ?? "perspective",
      navProfile: graphActiveViewportCameraState?.navigation ?? "trackball",
    },
    model: {
      discretization: femDiscretization ? "fem" : "fdm",
      worldExtent: ctx.worldExtent,
      worldCenter: ctx.worldCenter,
      selectedEntityFallbackId: selection.selectedEntityId,
      focusedEntityId: selection.focusedEntityId,
      selectedSidebarNodeId: selection.selectedSidebarNodeId,
      loading: ctx.previewBusy,
      message: ctx.previewMessage,
      error: ctx.error,
      pendingMeshBuild: builderMeshDirty,
      sourceKind: ctx.selectedVectorSourceKind,
      fieldDataTimestamp: ctx.fieldDataTimestamp,
      effectiveStep: ctx.effectiveStep,
      vectorField: viewport3DVectorField,
      authoring: showGeometryAuthoringViewport
        ? {
            enabled: true,
            activeTool: viewport3DInteractionMode,
            snapEnabled: Boolean(builderSnapSettings.enabled),
            snapSettings: {
              translateStepMeters: builderSnapSettings.translateStepMeters,
              rotateStepDeg: builderSnapSettings.rotateStepDeg,
              scaleStep: builderSnapSettings.scaleStep,
            },
          }
        : null,
      fdmSettings: fdmVisualizationSettings,
      fdmVectorsVisible: fdmVisualizationSettings.render_mode === "glyph",
    },
  });

  const { updateClass: viewport3DUpdateClass } = useViewport3DUpdateClassification({
    topologyRevision: resolvedFemTopologyKey,
    meshFieldRevision: scaledFemMeshData?.fieldRevision,
    dataFieldRevision: ctx.fieldDataRevision,
    effectiveViewMode: ctx.effectiveViewMode,
    selectedQuantity: ctx.selectedQuantity,
    effectiveVectorComponent: ctx.effectiveVectorComponent,
    meshRenderMode: viz.meshRenderMode,
    meshTrimKey: JSON.stringify(viz.meshTrim),
    meshClipEnabled: viz.meshClipEnabled,
    meshClipAxis: viz.meshClipAxis,
    meshClipPos: viz.meshClipPos,
    femVectorDomainFilter: vectorViz.domainFilter,
    femFerromagnetVisibilityMode: vectorViz.ferromagnetVisibilityMode,
  });

  const createViewport3DModel = viewport3DController.createModel;
  const hostedMixedViewportModel = useMemo(
    () => createViewport3DModel("mixed"),
    [createViewport3DModel],
  );
  const hostedFemViewportModel = useMemo(
    () => createViewport3DModel("fem"),
    [createViewport3DModel],
  );
  const hostedVectorSurfaceViewportModel = useMemo(
    () => createViewport3DModel("fdm"),
    [createViewport3DModel],
  );
  const hostedFemBoundsViewportModel = useMemo(
    () => createViewport3DModel("fem", "bounds-preview"),
    [createViewport3DModel],
  );

  const showFemBoundsPreview =
    femDiscretization &&
    !ctx.femMeshData &&
    (ctx.effectiveViewMode === "3D" || ctx.effectiveViewMode === "Mesh") &&
    displayObjectOverlays.length > 0;

  /* ── Viewport 3D rollout route ── */
  const viewport3DRolloutRoute = useMemo(() => {
    return resolveViewport3DRolloutRoute({
      minimalViewportSelectionPath,
      showGeometryAuthoringViewport,
      femDiscretization,
      effectiveViewMode: ctx.effectiveViewMode,
      hasFemMeshData: Boolean(ctx.femMeshData),
      showFemBoundsPreview,
      showVectorSurface3D,
      isVectorSurfaceMeshActive,
      cutover: viewport3dStages.viewport3d_unified_cutover,
    });
  }, [
    ctx.effectiveViewMode,
    ctx.femMeshData,
    femDiscretization,
    isVectorSurfaceMeshActive,
    minimalViewportSelectionPath,
    showVectorSurface3D,
    showFemBoundsPreview,
    showGeometryAuthoringViewport,
    viewport3dStages.viewport3d_unified_cutover,
  ]);

  useViewport3DRolloutTelemetry(
    viewport3DRolloutRoute,
    viewport3dStages.viewport3d_unified_cutover,
  );

  /* ── FEM live render debug ── */
  const femLiveRenderDebugData = useMemo(
    () =>
      buildFemLiveRenderDebugData({
        femDiscretization,
        viewMode: ctx.effectiveViewMode,
        fieldLabel: ctx.quantityDescriptor?.label ?? ctx.selectedQuantity,
        selectedVectorSourceKind: ctx.selectedVectorSourceKind,
        effectiveStep: ctx.effectiveStep,
        liveFieldSourceStep: ctx.liveFieldSourceStep,
        previewSourceStep: ctx.previewSourceStep,
        fieldData: scaledFemMeshData?.fieldData,
        meshFieldRevision: scaledFemMeshData?.fieldRevision,
        dataFieldRevision: ctx.fieldDataRevision,
        fieldDataTimestamp: ctx.fieldDataTimestamp,
        viewportUpdateClass: viewport3DUpdateClass,
      }),
    [
      ctx.effectiveStep,
      ctx.effectiveViewMode,
      ctx.fieldDataRevision,
      ctx.fieldDataTimestamp,
      ctx.liveFieldSourceStep,
      ctx.previewSourceStep,
      ctx.quantityDescriptor?.label,
      ctx.selectedQuantity,
      ctx.selectedVectorSourceKind,
      femDiscretization,
      scaledFemMeshData?.fieldData,
      scaledFemMeshData?.fieldRevision,
      viewport3DUpdateClass,
    ],
  );

  /* ── Resolved labels ── */
  const resolvedSliceQuantityLabel =
    ctx.quantityDescriptor?.label ?? scaledSpatialPreview?.quantity ?? ctx.selectedQuantity;
  const resolvedFemSliceQuantityLabel = ctx.quantityDescriptor?.label ?? ctx.selectedQuantity;

  /* ── Return bridge ── */
  return {
    ctx,
    runtimeSessionId,
    runtimeResourceRevisions,
    workspaceSelection,
    builderEnabled,
    builderViewportTool,
    builderSnapSettings,
    builderMeshSnapshot,
    builderGeometryRealization,
    builderMeshDirty,
    femDiscretization,
    meshWorkspaceResource,
    effectiveMeshWorkspaceModel,
    handleMeshWorkspaceBuild,
    handleMeshWorkspaceToolbarChange,
    viewport3DVectorField,
    scaledFetched3DVectors,
    scaledVectors,
    hasVectorData,
    scaleFactor,
    globalScalarPreview,
    scaledGlobalScalarPreview,
    spatialPreview,
    scaledSpatialPreview,
    selectedAntennaName,
    visibleObjectIds,
    antennaPreviewBadgeVisible,
    selectedFemObjectId,
    selectedObjectOverlay,
    displayObjectOverlays,
    femLayerState,
    femLayerRenderState,
    femObjectOverlaysForRender,
    femOpacityForRender,
    femAirColorFieldForRender,
    femColorFieldForRender,
    femMagneticColorFieldForRender,
    femShowArrowsForRender,
    effectiveFemMeshEntityViewState,
    geometryAuthoringShowPrimitives,
    geometryAuthoringShowMesh,
    geometryAuthoringShowQuantity,
    geometryAuthoringMeshStatus,
    geometryModeObjectOverlays,
    shouldUseSliceApi2D: shouldUseBackendSlice2D,
    sliceQuantityId,
    sliceComponent,
    slice2DModel,
    slice2D,
    scaledSliceScalar,
    sliceScalarShape,
    hasSliceScalar,
    scaledFemMeshData,
    scopedFetchedFemMeshData,
    shaderDownsampledFemMeshData,
    renderFemMeshData,
    resolvedFemTopologyKey,
    viewportFitSeed,
    graphActiveViewportDocumentId,
    graphActiveViewportCameraState,
    isVectorSurface3DActive,
    isVectorSurfaceMeshActive,
    showVectorSurface3D,
    showGeometryAuthoringViewport,
    geometryViewportPresetActive,
    showFemBoundsPreview,
    vectorSurfaceFieldLabel,
    vectorSurfaceVectors,
    vectorSurfaceSharedProps,
    missingExactScopeSegment,
    selectedSubmeshesToolboxOpen,
    minimalViewportSelectionPath,
    unifiedToolbarEnabled,
    viewport3DController,
    viewport3DRolloutRoute,
    hostedFemViewportModel,
    hostedMixedViewportModel,
    hostedVectorSurfaceViewportModel,
    hostedFemBoundsViewportModel,
    viewport3dStages,
    viewport3DInteractionMode,
    viewport3DRenderState,
    femToolbarMode,
    vectorToolbarMode,
    activeTextureTransform,
    activeTextureGizmoMode,
    activeTexturePreviewProxy,
    activeTextureMappingSpace,
    liveRenderDebugData,
    femLiveRenderDebugData,
    femQuantityOptions,
    resolvedSliceQuantityLabel,
    resolvedFemSliceQuantityLabel,
    graphViewportResultNodeId,
    handleRequestObjectSelect,
    handleFemSliceComponentChange,
    handleSlice2DToolbarChange,
    handlePreviewMaxPointsChange,
    patchMeshPartViewState,
    openSelectedSubmeshesToolbox,
    applyTextureTransform,
    persistViewportCameraState,
    setViewportCameraInteractionActive,
    viewportSelectedObjectId,
  } as const;
}

/** Inferred return type — use this as the prop type for `ViewportTabContent`. */
export type ViewportDataBridge = ReturnType<typeof useViewportDataBridge>;

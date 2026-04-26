"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAGNETIC_PRESET_CATALOG } from "@/lib/magnetizationPresetCatalog";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { useWorkspaceGraphStore } from "@/features";
import { useBuilderKeyboardShortcuts } from "@/features/geometry-builder";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import { displayPatchFromPreviewComponent } from "@/src/api/displaySelection";
import type { DisplaySelection } from "@/src/api/types";
import { useFieldSlice2D } from "@/src/hooks/resources/useFieldSlice2D";
import {
  useMeshWorkspaceModel,
  useSubmitMeshBuildCommand,
} from "@/src/hooks/resources/useMeshResources";
import { useSlice2DModel } from "@/src/hooks/resources/useSliceResource";
import { selectionFromControlRoomState } from "@/src/features/workspaceSync";
import type { MeshWorkspaceModel } from "@/src/features/meshWorkspace";
import type { Slice2DModel } from "@/src/features/slice2d";
import {
  resolveViewportInternalToolbarModes,
  useViewport3DController,
  useViewport3DVectorFieldModel,
} from "@/features/viewport-unified";
import { mapRouteFlagsToViewport3DStages } from "@/features/viewport-unified/model/viewport3dFlags";
import type { Viewport3DInteractionMode } from "@/features/viewport-unified/model/viewport3dContracts";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";
import type { UnifiedRenderState } from "@/features/viewport-unified/model/unifiedViewportTypes";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import type { TextureTransform3D as PreviewTextureTransform3D } from "@/lib/textureTransform";
import { recordFrontendPerfSample } from "@/lib/debug/frontendPerfDebug";
import type { TextureGizmoMode } from "@/components/preview/TextureTransformGizmo";
import type { FemLiveRenderDebugData } from "@/components/preview/fem/FemLiveRenderDebugPanel";
import type { RenderMode as FemRenderMode } from "@/components/preview/FemMeshView3D";
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
import { deriveFemLayerRenderState } from "@/components/runs/control-room/viewportLayers";
import type { MeshEntityViewStateMap } from "@/lib/session/types";
import { defaultMeshEntityViewState } from "@/lib/session/types";

/* ── Debug flag ───────────────────────────────────────────────────── */
const DEBUG_GIZMO_SYNC =
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  process.env.NODE_ENV !== "production";

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

function sliceAxisFromPlane(plane: "xy" | "xz" | "yz"): "x" | "y" | "z" {
  if (plane === "yz") return "x";
  if (plane === "xz") return "y";
  return "z";
}

function planeFromSliceAxis(axis: "x" | "y" | "z"): "xy" | "xz" | "yz" {
  if (axis === "x") return "yz";
  if (axis === "y") return "xz";
  return "xy";
}

function numericRevision(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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
export function useViewportDataBridge() {
  /* ── Context ── */
  const _transport = useTransport();
  const _viewport = useViewport();
  const _cmd = useCommand();
  const _model = useModel();
  const ctx = useMemo(
    () => ({ ..._transport, ..._viewport, ..._cmd, ..._model }),
    [_transport, _viewport, _cmd, _model],
  );

  /* ── Session runtime ── */
  const runtimeSessionId = useSessionRuntimeStore((s) => s.session?.session_id ?? null);
  const runtimeResourceRevisions = useSessionRuntimeStore((s) => s.resourceRevisions);

  /* ── Toolbar patch state ── */
  const [meshWorkspaceToolbarPatch, setMeshWorkspaceToolbarPatch] = useState<
    Partial<MeshWorkspaceModel["toolbar"]>
  >({});
  const [slice2DToolbarPatch, setSlice2DToolbarPatch] = useState<
    Partial<Slice2DModel["toolbar"]>
  >({});

  /* ── Workspace selection ── */
  const workspaceSelection = useMemo(
    () =>
      selectionFromControlRoomState({
        selectedObjectId: ctx.selectedObjectId,
        selectedEntityId: ctx.selectedEntityId,
        selectedSidebarNodeId: ctx.selectedSidebarNodeId,
        sourceSurface:
          ctx.effectiveViewMode === "Mesh"
            ? "mesh"
            : ctx.effectiveViewMode === "2D"
              ? "slice2d"
              : "viewport3d",
      }),
    [
      ctx.effectiveViewMode,
      ctx.selectedEntityId,
      ctx.selectedObjectId,
      ctx.selectedSidebarNodeId,
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
    enabled: ctx.effectiveViewMode === "Mesh",
    sessionKey: runtimeSessionId,
    resources: runtimeResourceRevisions,
    liveCapabilities: ctx.domainCapabilities,
  });
  const meshBuildCommand = useSubmitMeshBuildCommand({
    enabled: ctx.effectiveViewMode === "Mesh",
    sessionKey: runtimeSessionId,
  });

  /* ── ctx aliases (used in callbacks below) ── */
  const requestDisplayQuantity = ctx.requestDisplayQuantity;
  const setMeshClipAxis = ctx.setMeshClipAxis;
  const setMeshClipEnabled = ctx.setMeshClipEnabled;
  const setMeshClipPos = ctx.setMeshClipPos;
  const setMeshOpacity = ctx.setMeshOpacity;
  const setMeshRenderMode = ctx.setMeshRenderMode;
  const setMeshShowArrows = ctx.setMeshShowArrows;
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
      if (patch.renderMode) setMeshRenderMode(meshWorkspaceRenderModeToFem(patch.renderMode));
      if (typeof patch.opacity === "number") setMeshOpacity(patch.opacity);
      if (typeof patch.clipEnabled === "boolean") setMeshClipEnabled(patch.clipEnabled);
      if (patch.clipAxis) setMeshClipAxis(patch.clipAxis);
      if (typeof patch.clipPosition === "number") setMeshClipPos(patch.clipPosition);
    },
    [setMeshClipAxis, setMeshClipEnabled, setMeshClipPos, setMeshOpacity, setMeshRenderMode],
  );

  /* ── Derived flags ── */
  const showGeometryAuthoringViewport =
    builderEnabled && ctx.effectiveViewMode === "3D";
  const minimalViewportSelectionPath =
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.useMinimalViewportSelectionPath;

  /* ── Workspace store (right inspector) ── */
  const meshParts = ctx.meshParts;
  const setMeshEntityViewState = ctx.setMeshEntityViewState;
  const rightInspectorOpen = useWorkspaceStore((state) => state.rightInspectorOpen);
  const setRightInspectorOpen = useWorkspaceStore((state) => state.setRightInspectorOpen);
  const rightInspectorTab = useWorkspaceStore((state) => state.rightInspectorTab);
  const setRightInspectorTab = useWorkspaceStore((state) => state.setRightInspectorTab);

  /* ── Graph workspace ── */
  const graphActiveViewportDocument = useWorkspaceGraphStore((state) => {
    const id = state.snapshot.selection.activeViewportDocumentId;
    return id ? state.snapshot.viewportDocuments[id] ?? null : null;
  });
  const graphActiveResultNodeId = useWorkspaceGraphStore((state) =>
    state.snapshot.selection.activeResultNodeId,
  );
  const graphViewportResultNodeId =
    graphActiveViewportDocument?.selectedResultNodeId ?? graphActiveResultNodeId;

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

  /* ── FEM vector scopes ── */
  const femVectorScopes = useMemo(
    () =>
      deriveFemVectorScopes({
        meshParts: ctx.meshParts,
        meshEntityViewState: ctx.meshEntityViewState,
        airMeshVisible: ctx.airMeshVisible,
      }),
    [ctx.airMeshVisible, ctx.meshEntityViewState, ctx.meshParts],
  );
  const vectorFetchScope =
    femDiscretization && femVectorScopes.length === 1
      ? femVectorScopes[0]
      : { kind: "full" as const };
  const vectorAdapterPointCount = femDiscretization
    ? vectorFetchScope.kind !== "full"
      ? null
      : ctx.quantityDescriptor?.location === "cell"
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

  /* ── 3D vector field model ── */
  const viewport3DVectorField = useViewport3DVectorFieldModel({
    quantityId: ctx.selectedQuantity ?? null,
    fieldRevision: vectorFieldRevision,
    domainGenerationId: vectorDomainGenerationId,
    adapterPointCount: vectorAdapterPointCount,
    colorComponent:
      ctx.effectiveVectorComponent === "magnitude" ? "|v|" : ctx.effectiveVectorComponent,
    vectorsVisible: ctx.effectiveViewMode === "3D" && ctx.meshShowArrows,
    vectorCapabilityEnabled,
    unsupportedReason: null,
    quantityComponentCount: ctx.quantityDescriptor?.n_comp ?? null,
    everyN: ctx.requestedPreviewEveryN,
    maxGlyphs: ctx.requestedPreviewMaxPoints,
    scope: vectorFetchScope,
  });
  const hasVectorData = Boolean(
    (ctx.selectedVectors && ctx.selectedVectors.length > 0) ||
      (viewport3DVectorField.data && viewport3DVectorField.data.values.length > 0),
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
  const setSelectedObjectId = ctx.setSelectedObjectId;
  const setSelectedSidebarNodeId = ctx.setSelectedSidebarNodeId;
  const handleRequestObjectSelect = useCallback(
    (objectId: string) => {
      setSelectedObjectId(objectId);
      setSelectedSidebarNodeId(`obj-${objectId}`);
    },
    [setSelectedObjectId, setSelectedSidebarNodeId],
  );

  /* ── Antenna / overlays ── */
  const selectedAntennaName = resolveAntennaNodeName(
    ctx.selectedSidebarNodeId,
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
    console.groupCollapsed(
      `[GizmoSync] viewport object=${selectedSceneObject.name || selectedSceneObject.id} scope=${ctx.activeTransformScope ?? "none"}`,
    );
    console.log("scene object transform", summarizeTransform(selectedObjectTransform));
    if (selectedObjectOverlay) console.log("selected overlay anchor", selectedObjectOverlay);
    else console.log("selected overlay anchor", null);
    if (localTextureTransform) {
      console.log("texture transform in authoring space", {
        mapping_space: activeTextureMappingSpace,
        ...summarizeTransform(localTextureTransform),
        pivot: localTextureTransform.pivot,
      });
    }
    if (activeTextureTransform) {
      console.log("texture transform resolved for gizmo/world space", {
        ...summarizeTransform(activeTextureTransform),
        pivot: activeTextureTransform.pivot,
      });
    }
    if (hasMeaningfulRotation(selectedObjectTransform.rotation_quat)) {
      console.warn(
        "[GizmoSync] selected object has non-identity rotation_quat, but current viewport overlays are bounds-driven and axis-aligned.",
      );
    }
    console.groupEnd();
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

  /* ── FEM layer state ── */
  const femLayerState = ctx.femViewportLayers;
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
        const visibleIds = new Set(ctx.visibleMagneticObjectIds);
        const visibleOverlays = ctx.objectOverlays.filter((o) => visibleIds.has(o.id));
        return visibleOverlays.length > 0 ? visibleOverlays : ctx.objectOverlays;
      }
      return ctx.objectOverlays.filter((o) => visibleObjectIds.includes(o.id));
    },
    [
      ctx.objectOverlays,
      ctx.visibleMagneticObjectIds,
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
        meshOpacity: ctx.meshOpacity,
        colorField: ctx.femColorField,
        showArrows: ctx.meshShowArrows,
      }),
    [
      ctx.femColorField,
      ctx.meshOpacity,
      ctx.meshShowArrows,
      displayObjectOverlays,
      femLayerState,
    ],
  );
  const femObjectOverlaysForRender = femLayerRenderState.objectOverlays;
  const femOpacityForRender = femLayerRenderState.meshOpacity;
  const femColorFieldForRender = femLayerRenderState.colorField;
  const femShowArrowsForRender = femLayerRenderState.showArrows;

  const effectiveFemMeshEntityViewState = useMemo(() => {
    if (!femDiscretization || ctx.meshParts.length === 0) return ctx.meshEntityViewState;
    const next: MeshEntityViewStateMap = { ...ctx.meshEntityViewState };
    for (const part of ctx.meshParts) {
      const current = next[part.id] ?? defaultMeshEntityViewState(part);
      const renderMode =
        femLayerState.showMesh && current.renderMode === "surface"
          ? "surface+edges"
          : !femLayerState.showMesh && current.renderMode === "surface+edges"
            ? "surface"
            : current.renderMode;
      next[part.id] = {
        ...current,
        renderMode,
        opacity: ctx.meshOpacity,
        colorField:
          femLayerState.showQuantity && part.role === "magnetic_object"
            ? current.colorField
            : "none",
      };
    }
    return next;
  }, [
    ctx.meshEntityViewState,
    ctx.meshOpacity,
    ctx.meshParts,
    femDiscretization,
    femLayerState.showMesh,
    femLayerState.showQuantity,
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
          displayPatchFromPreviewComponent(nextComponent === "magnitude" ? "3D" : nextComponent),
        );
        return;
      }
      setComponent(nextComponent);
    },
    [previewControlsActive, setComponent, patchDisplay],
  );

  const handleSlice2DToolbarChange = useCallback(
    (patch: Partial<Slice2DModel["toolbar"]>) => {
      setSlice2DToolbarPatch((previous) => ({
        ...previous,
        showPrimitives: patch.showPrimitives ?? previous.showPrimitives,
        showMesh: patch.showMesh ?? previous.showMesh,
        showQuantity: patch.showQuantity ?? previous.showQuantity,
        showVectors: patch.showVectors ?? previous.showVectors,
        renderMode: patch.renderMode ?? previous.renderMode,
      }));
      if (patch.quantityId) requestDisplayQuantity(patch.quantityId);
      if (patch.component) handleFemSliceComponentChange(patch.component);
      if (patch.axis) setPlane(planeFromSliceAxis(patch.axis));
      if (patch.mode) {
        void patchDisplay({ slice_mode: patch.mode === "all_layers" ? "all" : patch.mode });
      }
      if (typeof patch.layerIndex === "number") {
        setSliceIndex(patch.layerIndex);
        void patchDisplay({ slice_layer: patch.layerIndex });
      }
      if (patch.colormap) void patchDisplay({ colormap: patch.colormap });
      if (typeof patch.autoContrast === "boolean") {
        void patchDisplay({ auto_contrast: patch.autoContrast });
      }
      if (typeof patch.showVectors === "boolean") {
        setMeshShowArrows(patch.showVectors);
        void patchDisplay({ vector_glyphs: patch.showVectors });
      }
    },
    [
      handleFemSliceComponentChange,
      patchDisplay,
      requestDisplayQuantity,
      setMeshShowArrows,
      setPlane,
      setSliceIndex,
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

  const missingExactScopeSegment = Boolean(
    femDiscretization &&
      ctx.femMeshData &&
      ctx.femMeshData.nElements > 0 &&
      selectedFemObjectId &&
      !hasExactScopeSegment,
  );

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
    if (!ctx.selectedVectors || scaleFactor === 1.0) return ctx.selectedVectors;
    const arr = new Float64Array(ctx.selectedVectors.length);
    for (let i = 0; i < arr.length; i++) arr[i] = ctx.selectedVectors[i] * scaleFactor;
    return arr;
  }, [ctx.selectedVectors, scaleFactor]);

  const scaledFetched3DVectors = useMemo(() => {
    if (viewport3DVectorField.status !== "ready") return null;
    const values = viewport3DVectorField.data?.values ?? null;
    if (!values) return null;
    if (scaleFactor === 1.0) return values;
    const arr = new Float64Array(values.length);
    for (let i = 0; i < arr.length; i++) arr[i] = values[i] * scaleFactor;
    return arr;
  }, [scaleFactor, viewport3DVectorField.data, viewport3DVectorField.status]);

  /* ── Slice 2D params ── */
  const sliceApiFeatureEnabled = ctx.isFemBackend
    ? FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFemSlice2D
    : FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFdmSlice2D;
  const femSliceTopologyReady = !ctx.isFemBackend || Boolean(ctx.femMeshData);
  const shouldUseSliceApi2D =
    ctx.effectiveViewMode === "2D" && sliceApiFeatureEnabled && femSliceTopologyReady;
  const sliceSampling = useMemo(
    () => deriveSliceSampling(ctx.previewGrid, ctx.plane, ctx.sliceIndex),
    [ctx.plane, ctx.previewGrid, ctx.sliceIndex],
  );
  const sliceFieldRevision = ctx.liveFieldSourceStep ?? ctx.effectiveStep ?? null;
  const sliceQuantityId = scaledSpatialPreview?.quantity ?? ctx.selectedQuantity;
  const sliceComponent = ctx.component;

  const sliceQuery = useMemo(
    () =>
      shouldUseSliceApi2D
        ? {
            plane: ctx.plane,
            component: sliceComponent,
            cut_norm: sliceSampling.cutNorm,
            x_size:
              ctx.requestedPreviewXChosenSize > 0
                ? ctx.requestedPreviewXChosenSize
                : sliceSampling.xPixels,
            y_size:
              ctx.requestedPreviewYChosenSize > 0
                ? ctx.requestedPreviewYChosenSize
                : sliceSampling.yPixels,
            max_points:
              ctx.requestedPreviewMaxPoints > 0 ? ctx.requestedPreviewMaxPoints : undefined,
            include_arrows: false,
            arrow_every: ctx.requestedPreviewEveryN,
            max_arrows: ctx.requestedPreviewMaxPoints,
          }
        : null,
    [
      ctx.plane,
      ctx.requestedPreviewEveryN,
      ctx.requestedPreviewMaxPoints,
      ctx.requestedPreviewXChosenSize,
      ctx.requestedPreviewYChosenSize,
      shouldUseSliceApi2D,
      sliceComponent,
      sliceSampling.cutNorm,
      sliceSampling.xPixels,
      sliceSampling.yPixels,
    ],
  );

  const unifiedSliceDisplaySelection = useMemo<DisplaySelection>(
    () => ({
      active_quantity_id: String(sliceQuantityId ?? ctx.selectedQuantity),
      view_mode: "2d",
      field_component: toDisplayFieldComponent(sliceComponent),
      colormap: "viridis",
      auto_contrast: ctx.requestedPreviewAutoScale,
      contrast_min: null,
      contrast_max: null,
      vector_glyphs: ctx.meshShowArrows,
      vector_density: ctx.requestedPreviewEveryN,
      slice_mode: ctx.requestedPreviewAllLayers ? "all_layers" : "single",
      slice_layer: ctx.sliceIndex,
      max_points: ctx.requestedPreviewMaxPoints,
      x_chosen_size: ctx.requestedPreviewXChosenSize,
      y_chosen_size: ctx.requestedPreviewYChosenSize,
    }),
    [
      ctx.meshShowArrows,
      ctx.requestedPreviewAllLayers,
      ctx.requestedPreviewAutoScale,
      ctx.requestedPreviewEveryN,
      ctx.requestedPreviewMaxPoints,
      ctx.requestedPreviewXChosenSize,
      ctx.requestedPreviewYChosenSize,
      ctx.selectedQuantity,
      ctx.sliceIndex,
      sliceComponent,
      sliceQuantityId,
    ],
  );

  const slice2DPlaneOptions = useMemo(
    () => ({
      axis: sliceAxisFromPlane(ctx.plane),
      positionPercent: sliceSampling.cutNorm * 100,
    }),
    [ctx.plane, sliceSampling.cutNorm],
  );

  const slice2DBaseModel = useSlice2DModel({
    display: unifiedSliceDisplaySelection,
    resources: runtimeResourceRevisions,
    capabilities: ctx.domainCapabilities,
    adapterKind: femDiscretization ? "fem" : "fdm",
    planeOptions: slice2DPlaneOptions,
  });

  const slice2DModel = useMemo<Slice2DModel>(() => {
    const toolbar = { ...slice2DBaseModel.toolbar, ...slice2DToolbarPatch };
    return {
      ...slice2DBaseModel,
      toolbar,
      overlays: {
        ...slice2DBaseModel.overlays,
        showPrimitives: toolbar.showPrimitives,
        showMesh: toolbar.showMesh,
        showQuantity: toolbar.showQuantity,
        showVectors: toolbar.showVectors,
      },
    };
  }, [slice2DBaseModel, slice2DToolbarPatch]);

  const slice2D = useFieldSlice2D(
    shouldUseSliceApi2D ? sliceQuantityId : null,
    shouldUseSliceApi2D ? sliceFieldRevision : null,
    0,
    sliceQuery,
  );

  const scaledSliceScalar = useMemo(() => {
    const scalar = slice2D.scalar;
    if (!scalar) return null;
    if (scaleFactor === 1.0) return scalar.values;
    return Float64Array.from(scalar.values, (v) => v * scaleFactor);
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
    () => ({
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
  const scaledFemMeshData = useMemo(() => {
    if (!femMeshData || scaleFactor === 1.0 || !femMeshData.fieldData) return femMeshData;
    const fld = femMeshData.fieldData;
    return {
      ...femMeshData,
      fieldData: {
        ...fld,
        x: fld.x ? Float64Array.from(fld.x, (v) => v * scaleFactor) : null,
        y: fld.y ? Float64Array.from(fld.y, (v) => v * scaleFactor) : null,
        z: fld.z ? Float64Array.from(fld.z, (v) => v * scaleFactor) : null,
      },
    } as typeof femMeshData;
  }, [femMeshData, scaleFactor]);

  const scopedFetchedFemMeshData = useMemo(() => {
    if (
      !scaledFemMeshData ||
      !femDiscretization ||
      vectorFetchScope.kind === "full" ||
      viewport3DVectorField.status !== "ready" ||
      !viewport3DVectorField.data
    ) return scaledFemMeshData;
    const dense = buildDenseFemVectorField({
      nNodes: scaledFemMeshData.nNodes,
      meshParts: ctx.meshParts,
      frames: [{ scope: vectorFetchScope, field: viewport3DVectorField.data }],
    });
    if (!dense) return scaledFemMeshData;
    const values =
      scaleFactor === 1.0
        ? dense.values
        : Float64Array.from(dense.values, (v) => v * scaleFactor);
    const x = new Float64Array(scaledFemMeshData.nNodes);
    const y = new Float64Array(scaledFemMeshData.nNodes);
    const z = new Float64Array(scaledFemMeshData.nNodes);
    for (let i = 0; i < scaledFemMeshData.nNodes; i++) {
      x[i] = values[i * 3] ?? 0;
      y[i] = values[i * 3 + 1] ?? 0;
      z[i] = values[i * 3 + 2] ?? 0;
    }
    return {
      ...scaledFemMeshData,
      fieldData: { x, y, z },
      fieldNComp: dense.nComp,
      activeMask: dense.activeMask,
      fieldRevision: viewport3DVectorField.fieldRevision ?? scaledFemMeshData.fieldRevision,
    };
  }, [
    ctx.meshParts,
    femDiscretization,
    scaleFactor,
    scaledFemMeshData,
    vectorFetchScope,
    viewport3DVectorField.data,
    viewport3DVectorField.fieldRevision,
    viewport3DVectorField.status,
  ]);

  const resolvedFemTopologyKey = useMemo(() => {
    const explicit = ctx.femTopologyKey?.trim();
    if (explicit) return explicit;
    const gen = scaledFemMeshData?.meshGenerationId?.trim();
    if (gen) return `gen:${gen}`;
    return null;
  }, [ctx.femTopologyKey, scaledFemMeshData?.meshGenerationId]);

  const viewportFitSeed = useMemo(() => {
    const sampleKey = scaledFemMeshData
      ? `${scaledFemMeshData.nNodes}:${scaledFemMeshData.nElements}:${scaledFemMeshData.boundaryFaces.length}`
      : "none";
    return [
      effectiveViewMode,
      resolvedFemTopologyKey ?? "no-topology",
      sampleKey,
      ctx.focusObjectRequest?.objectId ?? "none",
      String(ctx.focusObjectRequest?.revision ?? 0),
    ].join("|");
  }, [
    scaledFemMeshData,
    effectiveViewMode,
    resolvedFemTopologyKey,
    ctx.focusObjectRequest,
  ]);

  /* ── Viewport route determination ── */
  const isVectorSurface3DActive =
    ctx.effectiveViewMode === "3D" &&
    !femDiscretization &&
    (ctx.isVectorQuantity || hasVectorData) &&
    !globalScalarPreview;
  const isVectorSurfaceMeshActive =
    ctx.effectiveViewMode === "Mesh" && !femDiscretization && !ctx.femMeshData;
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
      focusObjectRequest: ctx.focusObjectRequest,
      objectViewMode: ctx.objectViewMode,
      settings: ctx.fdmVisualizationSettings,
      onSettingsChange: ctx.setFdmVisualizationSettings,
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
      ctx.fdmVisualizationSettings,
      ctx.focusObjectRequest,
      ctx.objectOverlays,
      ctx.objectViewMode,
      ctx.previewGrid,
      ctx.setFdmVisualizationSettings,
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
  const viewport3DInteractionMode: Viewport3DInteractionMode = showGeometryAuthoringViewport
    ? toViewportInteractionMode(builderViewportTool)
    : "camera";
  const viewport3DRenderState = useMemo<UnifiedRenderState>(
    () => ({
      selectedLayer: ctx.requestedPreviewLayer ?? ctx.sliceIndex,
      allLayersVisible: ctx.requestedPreviewAllLayers,
      vectorComponent: toUnifiedVectorComponent(
        ctx.effectiveViewMode === "3D" ? "3D" : ctx.requestedPreviewComponent,
      ),
      colorScale: "viridis",
      autoScale: ctx.requestedPreviewAutoScale,
      maxPoints: ctx.requestedPreviewMaxPoints,
      everyN: ctx.requestedPreviewEveryN,
      meshRenderMode: toUnifiedRenderMode(ctx.meshRenderMode),
      meshOpacity: ctx.meshOpacity,
      clipEnabled: ctx.meshClipEnabled,
      clipAxis: ctx.meshClipAxis,
      clipPosition: ctx.meshClipPos,
      femLayers: ctx.femViewportLayers,
    }),
    [
      ctx.effectiveViewMode,
      ctx.femViewportLayers,
      ctx.meshClipAxis,
      ctx.meshClipEnabled,
      ctx.meshClipPos,
      ctx.meshOpacity,
      ctx.meshRenderMode,
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
        partId: ctx.selectedEntityId,
      },
      clip: {
        enabled: ctx.meshClipEnabled,
        axis: ctx.meshClipAxis,
        position: ctx.meshClipPos,
        invert: ctx.meshClipFlip,
      },
      topologyFallbackRevision: resolvedFemTopologyKey,
      femMeshFieldRevision: scaledFemMeshData?.fieldRevision,
      dataPlaneFieldRevision: ctx.fieldDataRevision,
      selectedVectorCount:
        ctx.selectedVectors?.length ?? viewport3DVectorField.data?.values.length ?? 0,
    },
    toolbar: {
      clipFlip: ctx.meshClipFlip,
      interactionMode: viewport3DInteractionMode,
      snapEnabled: Boolean(builderSnapSettings.enabled),
      objectViewMode: ctx.objectViewMode,
      vectorsVisible: ctx.meshShowArrows,
      legendVisible: ctx.viewportLegendVisible,
      partExplorerVisible: selectedSubmeshesToolboxOpen,
      projection: "perspective",
      navProfile: "trackball",
    },
    model: {
      discretization: femDiscretization ? "fem" : "fdm",
      worldExtent: ctx.worldExtent,
      worldCenter: ctx.worldCenter,
      selectedEntityFallbackId: ctx.selectedEntityId,
      focusedEntityId: ctx.focusedEntityId,
      selectedSidebarNodeId: ctx.selectedSidebarNodeId,
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
      fdmSettings: ctx.fdmVisualizationSettings,
      fdmVectorsVisible: ctx.fdmVisualizationSettings.render_mode === "glyph",
    },
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
    let route:
      | "minimal-diagnostic"
      | "geometry-authoring"
      | "fem-3d"
      | "fem-mesh"
      | "fem-bounds-fallback"
      | "fdm-3d"
      | "fdm-mesh"
      | "slice-2d"
      | "analyze"
      | "empty" = "empty";
    let fallbackUsed = false;
    if (minimalViewportSelectionPath) {
      route = "minimal-diagnostic";
    } else if (showGeometryAuthoringViewport) {
      route = "geometry-authoring";
    } else if (
      femDiscretization &&
      (ctx.effectiveViewMode === "3D" || ctx.effectiveViewMode === "Mesh")
    ) {
      if (!ctx.femMeshData && showFemBoundsPreview) {
        route = "fem-bounds-fallback";
        fallbackUsed = true;
      } else {
        route = ctx.effectiveViewMode === "Mesh" ? "fem-mesh" : "fem-3d";
      }
    } else if (showVectorSurface3D) {
      route = isVectorSurfaceMeshActive ? "fdm-mesh" : "fdm-3d";
    } else if (ctx.effectiveViewMode === "2D") {
      route = "slice-2d";
    } else if (ctx.effectiveViewMode === "Analyze") {
      route = "analyze";
    }
    return {
      route,
      fallbackUsed,
      signature: `${route}|${fallbackUsed ? "fallback" : "primary"}|${
        viewport3dStages.viewport3d_unified_cutover ? "cutover" : "staged"
      }`,
    };
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

  const lastViewport3DRolloutSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastViewport3DRolloutSignatureRef.current === viewport3DRolloutRoute.signature) return;
    lastViewport3DRolloutSignatureRef.current = viewport3DRolloutRoute.signature;
    const timestampMs =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    recordFrontendPerfSample({
      scope: "Viewport3DRollout",
      phase: "route-selected",
      durationMs: 0,
      timestampMs,
      meta: {
        route: viewport3DRolloutRoute.route,
        fallbackUsed: viewport3DRolloutRoute.fallbackUsed,
        cutover: viewport3dStages.viewport3d_unified_cutover,
      },
    });
    if (viewport3DRolloutRoute.fallbackUsed) {
      recordFrontendPerfSample({
        scope: "Viewport3DRollout",
        phase: "fallback-used",
        durationMs: 0,
        timestampMs,
        meta: {
          route: viewport3DRolloutRoute.route,
          cutover: viewport3dStages.viewport3d_unified_cutover,
        },
      });
    }
  }, [
    viewport3DRolloutRoute.fallbackUsed,
    viewport3DRolloutRoute.route,
    viewport3DRolloutRoute.signature,
    viewport3dStages.viewport3d_unified_cutover,
  ]);

  /* ── FEM live render debug ── */
  const femLiveRenderDebugData = useMemo<FemLiveRenderDebugData | null>(
    () =>
      femDiscretization
        ? {
            backendLabel: "fem",
            viewMode: ctx.effectiveViewMode,
            fieldLabel: ctx.quantityDescriptor?.label ?? ctx.selectedQuantity,
            viewportLabel: "FEM meshData",
            transportLabel: ctx.selectedVectorSourceKind,
            solverStep: ctx.effectiveStep,
            bufferSourceStep:
              ctx.selectedVectorSourceKind === "live"
                ? ctx.liveFieldSourceStep
                : ctx.selectedVectorSourceKind === "preview"
                  ? ctx.previewSourceStep
                  : null,
            liveFieldSourceStep: ctx.liveFieldSourceStep,
            previewSourceStep: ctx.previewSourceStep,
            fieldData: scaledFemMeshData?.fieldData,
            fieldRevision:
              scaledFemMeshData?.fieldRevision != null
                ? String(scaledFemMeshData.fieldRevision)
                : ctx.fieldDataRevision != null
                  ? String(ctx.fieldDataRevision)
                  : null,
            fieldDataTimestamp: ctx.fieldDataTimestamp ?? null,
          }
        : null,
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
    femColorFieldForRender,
    femShowArrowsForRender,
    effectiveFemMeshEntityViewState,
    geometryAuthoringShowPrimitives,
    geometryAuthoringShowMesh,
    geometryAuthoringShowQuantity,
    geometryAuthoringMeshStatus,
    geometryModeObjectOverlays,
    shouldUseSliceApi2D,
    sliceQuantityId,
    sliceComponent,
    slice2DModel,
    slice2D,
    scaledSliceScalar,
    sliceScalarShape,
    hasSliceScalar,
    scaledFemMeshData,
    scopedFetchedFemMeshData,
    resolvedFemTopologyKey,
    viewportFitSeed,
    isVectorSurface3DActive,
    isVectorSurfaceMeshActive,
    showVectorSurface3D,
    showGeometryAuthoringViewport,
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
    viewportSelectedObjectId,
  } as const;
}

/** Inferred return type — use this as the prop type for `ViewportTabContent`. */
export type ViewportDataBridge = ReturnType<typeof useViewportDataBridge>;

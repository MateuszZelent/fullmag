"use client";

import { memo, useMemo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

import { MAGNETIC_PRESET_CATALOG } from "@/lib/magnetizationPresetCatalog";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { ViewportHost, useWorkspaceGraphStore } from "@/features";
import {
  BuilderViewportLayer,
  GeometryToolbar,
  useBuilderKeyboardShortcuts,
} from "@/features/geometry-builder";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import { displayPatchFromPreviewComponent } from "@/src/api/displaySelection";
import type { DisplaySelection, FieldComponent } from "@/src/api/types";
import { useFieldSlice2D } from "@/src/hooks/resources/useFieldSlice2D";
import {
  useMeshWorkspaceModel,
  useSubmitMeshBuildCommand,
} from "@/src/hooks/resources/useMeshResources";
import { useSlice2DModel } from "@/src/hooks/resources/useSliceResource";
import { MeshWorkspaceShell } from "@/src/features/meshWorkspace";
import type { MeshWorkspaceModel } from "@/src/features/meshWorkspace";
import type { Slice2DModel } from "@/src/features/slice2d";
import {
  DEFAULT_WORKSPACE_SYNC_STATE,
  selectionFromControlRoomState,
} from "@/src/features/workspaceSync";
import {
  resolveViewportInternalToolbarModes,
  UnifiedViewport3DRenderer,
  Viewport3DHost,
  useViewport3DController,
} from "@/features/viewport-unified";
import { mapRouteFlagsToViewport3DStages } from "@/features/viewport-unified/model/viewport3dFlags";
import type {
  Viewport3DInteractionMode,
} from "@/features/viewport-unified/model/viewport3dContracts";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";
import type { UnifiedRenderState } from "@/features/viewport-unified/model/unifiedViewportTypes";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import type { TextureTransform3D as PreviewTextureTransform3D } from "@/lib/textureTransform";
import { recordFrontendPerfSample } from "@/lib/debug/frontendPerfDebug";
import type { TextureGizmoMode } from "../../preview/TextureTransformGizmo";
import type { FemLiveRenderDebugData } from "../../preview/fem/FemLiveRenderDebugPanel";
import FemMeshView3D, { type RenderMode as FemRenderMode } from "../../preview/FemMeshView3D";
import { ViewportErrorBoundary } from "../../preview/ViewportErrorBoundary";
import EmptyState from "../../ui/EmptyState";
import {
  fmtExp,
  fmtSI,
  resolveAntennaNodeName,
} from "./shared";
import { useTransport, useViewport, useCommand, useModel } from "./context-hooks";
import UnifiedViewport2DPresenter from "./UnifiedViewport2DPresenter";
import UnifiedViewport3DVectorSurface from "./UnifiedViewport3DVectorSurface";
import type {
  MeshEntityViewStateMap,
} from "../../../lib/session/types";
import { defaultMeshEntityViewState } from "../../../lib/session/types";
import {
  toPreviewTextureTransform,
  toSceneTextureTransform,
  textureTransformToWorld,
  textureTransformToLocal,
} from "./viewportUtils";
import type { Vec3, Quat } from "./viewportUtils";
import { deriveFemLayerRenderState } from "./viewportLayers";
export { ViewportBar } from "./ViewportBar";

const DEBUG_GIZMO_SYNC =
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  process.env.NODE_ENV !== "production";

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
  if (mode === "wireframe" || mode === "points") {
    return mode;
  }
  if (mode === "surface+edges") {
    return "solid+wireframe";
  }
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

function toDisplayFieldComponent(component: string): DisplaySelection["field_component"] {
  if (component === "x" || component === "y" || component === "z") {
    return component;
  }
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

function requireFemTopologyKey(value: string | null): string {
  if (value && value.length > 0) {
    return value;
  }
  throw new Error("[ViewportPanels] Missing required FEM topologyKey for FemMeshView3D.");
}

function deriveSliceSampling(
  grid: [number, number, number],
  plane: "xy" | "xz" | "yz",
  sliceIndex: number,
): {
  cutNorm: number;
  xPixels: number;
  yPixels: number;
} {
  const [nx, ny, nz] = grid;
  if (plane === "xy") {
    const maxIndex = Math.max(nz - 1, 0);
    const cutNorm = maxIndex > 0 ? clamp01(sliceIndex / maxIndex) : 0.5;
    return { cutNorm, xPixels: Math.max(nx, 1), yPixels: Math.max(ny, 1) };
  }
  if (plane === "xz") {
    const maxIndex = Math.max(ny - 1, 0);
    const cutNorm = maxIndex > 0 ? clamp01(sliceIndex / maxIndex) : 0.5;
    return { cutNorm, xPixels: Math.max(nx, 1), yPixels: Math.max(nz, 1) };
  }
  const maxIndex = Math.max(nx - 1, 0);
  const cutNorm = maxIndex > 0 ? clamp01(sliceIndex / maxIndex) : 0.5;
  return { cutNorm, xPixels: Math.max(ny, 1), yPixels: Math.max(nz, 1) };
}

function ViewportModuleLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

const PreviewScalarField2D = dynamic(() => import("../../preview/PreviewScalarField2D"), {
  ssr: false,
  loading: () => <ViewportModuleLoading label="Loading scalar viewport..." />,
});

const AnalyzeViewport = dynamic(() => import("./AnalyzeViewport"), {
  ssr: false,
  loading: () => <ViewportModuleLoading label="Loading analyze viewport..." />,
});

const ResultNodeViewport = dynamic(() => import("./ResultNodeViewport"), {
  ssr: false,
  loading: () => <ViewportModuleLoading label="Loading result viewport..." />,
});

function quatToEulerDeg(
  q: [number, number, number, number],
): [number, number, number] {
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

const VIEWPORT_BADGE_STYLE = { zIndex: "var(--z-viewport-badge)" } as const;

export const ViewportCanvasArea = memo(function ViewportCanvasArea() {
  /* Granular hooks replacing useControlRoom */
  const _transport = useTransport();
  const _viewport = useViewport();
  const _cmd = useCommand();
  const _model = useModel();
  const ctx = useMemo(
    () => ({ ..._transport, ..._viewport, ..._cmd, ..._model }),
    [_transport, _viewport, _cmd, _model],
  );
  const runtimeSessionId = useSessionRuntimeStore((s) => s.session?.session_id ?? null);
  const runtimeResourceRevisions = useSessionRuntimeStore((s) => s.resourceRevisions);
  const workspaceSyncState = DEFAULT_WORKSPACE_SYNC_STATE;
  const [meshWorkspaceToolbarPatch, setMeshWorkspaceToolbarPatch] = useState<
    Partial<MeshWorkspaceModel["toolbar"]>
  >({});
  const [slice2DToolbarPatch, setSlice2DToolbarPatch] = useState<
    Partial<Slice2DModel["toolbar"]>
  >({});
  const workspaceSelection = useMemo(
    () =>
      selectionFromControlRoomState({
        selectedObjectId: ctx.selectedObjectId,
        selectedEntityId: ctx.selectedEntityId,
        selectedSidebarNodeId: ctx.selectedSidebarNodeId,
        sourceSurface: ctx.effectiveViewMode === "Mesh" ? "mesh" : ctx.effectiveViewMode === "2D" ? "slice2d" : "viewport3d",
      }),
    [
      ctx.effectiveViewMode,
      ctx.selectedEntityId,
      ctx.selectedObjectId,
      ctx.selectedSidebarNodeId,
    ],
  );
  const builderEnabled = useGeometryBuilderStore((s) => s.builderMode.enabled);
  const builderViewportTool = useGeometryBuilderStore((s) => s.viewportTool);
  const builderSnapSettings = useGeometryBuilderStore((s) => s.snapSettings);
  const builderMeshSnapshot = useGeometryBuilderStore((s) => s.meshSnapshot);
  const builderGeometryRealization = useGeometryBuilderStore((s) => s.geometryRealization);
  const builderMeshDirty = useGeometryBuilderStore((s) => s.dirty.meshDirty);
  useBuilderKeyboardShortcuts();
  const femDiscretization = resolveFemDiscretization(ctx.domainCapabilities, false);
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
      .submit({
        mesh_target: { kind: "study_domain" },
        mesh_reason: "mesh_workspace_shell",
      })
      .then(() => meshWorkspaceResource.refresh());
  }, [meshBuildCommand, meshWorkspaceResource]);
  const effectiveMeshWorkspaceModel = useMemo<MeshWorkspaceModel | null>(() => {
    if (!meshWorkspaceResource.model) return null;
    return {
      ...meshWorkspaceResource.model,
      toolbar: {
        ...meshWorkspaceResource.model.toolbar,
        ...meshWorkspaceToolbarPatch,
      },
    };
  }, [meshWorkspaceResource.model, meshWorkspaceToolbarPatch]);
  const handleMeshWorkspaceToolbarChange = useCallback(
    (patch: Partial<MeshWorkspaceModel["toolbar"]>) => {
      setMeshWorkspaceToolbarPatch((previous) => ({ ...previous, ...patch }));
      if (patch.renderMode) {
        setMeshRenderMode(meshWorkspaceRenderModeToFem(patch.renderMode));
      }
      if (typeof patch.opacity === "number") {
        setMeshOpacity(patch.opacity);
      }
      if (typeof patch.clipEnabled === "boolean") {
        setMeshClipEnabled(patch.clipEnabled);
      }
      if (patch.clipAxis) {
        setMeshClipAxis(patch.clipAxis);
      }
      if (typeof patch.clipPosition === "number") {
        setMeshClipPos(patch.clipPosition);
      }
    },
    [
      setMeshClipAxis,
      setMeshClipEnabled,
      setMeshClipPos,
      setMeshOpacity,
      setMeshRenderMode,
    ],
  );
  const showGeometryAuthoringViewport =
    builderEnabled && ctx.effectiveViewMode === "3D";
  const minimalViewportSelectionPath = FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.useMinimalViewportSelectionPath;
  const setSelectedObjectId = ctx.setSelectedObjectId;
  const setSelectedSidebarNodeId = ctx.setSelectedSidebarNodeId;
  const meshParts = ctx.meshParts;
  const setMeshEntityViewState = ctx.setMeshEntityViewState;
  const rightInspectorOpen = useWorkspaceStore((state) => state.rightInspectorOpen);
  const setRightInspectorOpen = useWorkspaceStore((state) => state.setRightInspectorOpen);
  const rightInspectorTab = useWorkspaceStore((state) => state.rightInspectorTab);
  const setRightInspectorTab = useWorkspaceStore((state) => state.setRightInspectorTab);
  const graphActiveViewportDocument = useWorkspaceGraphStore((state) => {
    const id = state.snapshot.selection.activeViewportDocumentId;
    return id ? state.snapshot.viewportDocuments[id] ?? null : null;
  });
  const graphActiveResultNodeId = useWorkspaceGraphStore((state) =>
    state.snapshot.selection.activeResultNodeId,
  );
  const graphViewportResultNodeId =
    graphActiveViewportDocument?.selectedResultNodeId ?? graphActiveResultNodeId;
  const effectiveViewMode = ctx.effectiveViewMode;
  const femMeshData = ctx.femMeshData;
  const visibleSubmeshSnapshot = ctx.visibleSubmeshSnapshot;
  const setVisibleSubmeshSnapshot = ctx.setVisibleSubmeshSnapshot;
  const patchDisplay = ctx.patchDisplay;
  const previewControlsActive = ctx.previewControlsActive;
  const setComponent = ctx.setComponent;
  const setActiveTransformScope = ctx.setActiveTransformScope;
  const setSceneDocument = ctx.setSceneDocument;
  const spatialPreview = ctx.preview?.kind === "spatial" ? ctx.preview : null;
  const globalScalarPreview = ctx.preview?.kind === "global_scalar" ? ctx.preview : null;
  const hasVectorData = Boolean(ctx.selectedVectors && ctx.selectedVectors.length > 0);
  const viewportSelectedObjectId = ctx.viewportSelectedObjectId;
  const selectedMagnetizationAsset = useMemo(() => {
    if (!ctx.sceneDocument || !viewportSelectedObjectId) {
      return null;
    }
    const selectedObject = ctx.sceneDocument.objects.find(
      (object) =>
        object.id === viewportSelectedObjectId || object.name === viewportSelectedObjectId,
    );
    if (!selectedObject) {
      return null;
    }
    return (
      ctx.sceneDocument.magnetization_assets.find(
        (asset) => asset.id === selectedObject.magnetization_ref,
      ) ?? null
    );
  }, [ctx.sceneDocument, viewportSelectedObjectId]);
  const selectedSceneObject = useMemo(() => {
    if (!ctx.sceneDocument || !viewportSelectedObjectId) {
      return null;
    }
    return (
      ctx.sceneDocument.objects.find(
        (object) =>
          object.id === viewportSelectedObjectId || object.name === viewportSelectedObjectId,
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
    selectedMagnetizationAsset?.kind === "preset_texture" && ctx.activeTransformScope === "texture"
      ? (() => {
          const base =
            localTextureTransform ??
            toPreviewTextureTransform(selectedMagnetizationAsset.texture_transform);
          if (activeTextureMappingSpace !== "object") {
            return base;
          }
          // In object-space mapping, we author texture transform in object-local coordinates.
          // The viewport gizmo operates in world-space, so apply full object transform for display.
          return textureTransformToWorld(base, selectedObjectTransform);
        })()
      : null;
  const activeTexturePreviewProxy =
    selectedMagnetizationAsset?.preset_kind
      ? (
          MAGNETIC_PRESET_CATALOG.find(
            (descriptor) => descriptor.kind === selectedMagnetizationAsset.preset_kind,
          )?.previewProxy ?? "box"
        )
      : "box";
  const activeTextureGizmoMode: TextureGizmoMode =
    ctx.sceneDocument?.editor.gizmo_mode === "rotate"
      ? "rotate"
      : ctx.sceneDocument?.editor.gizmo_mode === "scale"
        ? "scale"
        : "translate";
  const applyTextureTransform = useCallback(
    (next: PreviewTextureTransform3D) => {
      if (!viewportSelectedObjectId) {
        return;
      }
      setSceneDocument((previousScene) => {
        if (!previousScene) {
          return previousScene;
        }
        const selectedObject = previousScene.objects.find(
          (object) =>
            object.id === viewportSelectedObjectId || object.name === viewportSelectedObjectId,
        );
        if (!selectedObject) {
          return previousScene;
        }
        const selectedMagnetization = previousScene.magnetization_assets.find(
          (asset) => asset.id === selectedObject.magnetization_ref,
        );
        if (!selectedMagnetization) {
          return previousScene;
        }
        const mappingSpace =
          selectedMagnetization.mapping?.space === "world" ? "world" : "object";
        const nextLocalTransform =
          mappingSpace === "world"
            ? next
            : textureTransformToLocal(next, {
                translation: [...selectedObject.transform.translation] as Vec3,
                rotation_quat: [...selectedObject.transform.rotation_quat] as Quat,
                scale: [...selectedObject.transform.scale] as Vec3,
              });
        const normalizedTransform =
          selectedMagnetization.kind === "preset_texture" &&
          selectedMagnetization.preset_kind === "vortex"
            ? {
                ...nextLocalTransform,
                pivot: [0, 0, 0] as Vec3,
              }
            : nextLocalTransform;
        return {
          ...previousScene,
          magnetization_assets: previousScene.magnetization_assets.map((asset) =>
            asset.id === selectedObject.magnetization_ref
              ? {
                  ...asset,
                  texture_transform: toSceneTextureTransform(normalizedTransform),
                }
              : asset,
          ),
          editor: {
            ...previousScene.editor,
            active_transform_scope: "texture",
          },
        };
      });
    },
    [setSceneDocument, viewportSelectedObjectId],
  );

  const handleRequestObjectSelect = useCallback(
    (objectId: string) => {
      setSelectedObjectId(objectId);
      setSelectedSidebarNodeId(`obj-${objectId}`);
    },
    [setSelectedObjectId, setSelectedSidebarNodeId],
  );

  const selectedAntennaName = resolveAntennaNodeName(
    ctx.selectedSidebarNodeId,
    ctx.scriptBuilderCurrentModules.map((module) => module.name),
  );
  const visibleObjectIds = useMemo(
    () =>
      (ctx.sceneDocument?.objects ?? [])
        .filter((object) => object.visible !== false)
        .map((object) => object.name || object.id)
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
        ? ctx.objectOverlays.find((overlay) => overlay.id === selectedFemObjectId) ?? null
        : null,
    [ctx.objectOverlays, selectedFemObjectId],
  );
  const gizmoDiagnosticSignatureRef = useRef<string>("");
  useEffect(() => {
    if (!DEBUG_GIZMO_SYNC || !selectedSceneObject) {
      return;
    }
    const signature = JSON.stringify({
      objectId: selectedSceneObject.id,
      activeTransformScope: ctx.activeTransformScope,
      mappingSpace: activeTextureMappingSpace,
      objectTransform: selectedObjectTransform,
      localTextureTransform,
      activeTextureTransform,
      selectedObjectOverlay,
    });
    if (signature === gizmoDiagnosticSignatureRef.current) {
      return;
    }
    gizmoDiagnosticSignatureRef.current = signature;

    console.groupCollapsed(
      `[GizmoSync] viewport object=${selectedSceneObject.name || selectedSceneObject.id} scope=${ctx.activeTransformScope ?? "none"}`,
    );
    console.log("scene object transform", summarizeTransform(selectedObjectTransform));
    if (selectedObjectOverlay) {
      console.log("selected overlay anchor", selectedObjectOverlay);
    } else {
      console.log("selected overlay anchor", null);
    }
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
        "[GizmoSync] selected object has non-identity rotation_quat, but current viewport overlays are bounds-driven and axis-aligned. The anchor used by gizmo/preview can drift because overlay extraction does not encode oriented object geometry.",
      );
      console.warn(
        "[GizmoSync] SceneDocument -> ScriptBuilder export currently re-materializes translation into geometry_params, but not object rotation. That means rotation is not flowing through the same canonical path as translation yet.",
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
  const displayObjectOverlays = useMemo(
    () => {
      if (femDiscretization && ctx.meshParts.length > 0) {
        return ctx.objectOverlays.filter((overlay) =>
          ctx.visibleMagneticObjectIds.includes(overlay.id),
        );
      }
      return ctx.objectOverlays.filter((overlay) => visibleObjectIds.includes(overlay.id));
    },
    [ctx.meshParts.length, ctx.objectOverlays, ctx.visibleMagneticObjectIds, femDiscretization, visibleObjectIds],
  );
  const femLayerState = ctx.femViewportLayers;
  const geometryAuthoringShowPrimitives = femLayerState.showPrimitives;
  const geometryAuthoringShowMesh = femLayerState.showMesh;
  const geometryAuthoringShowQuantity = femLayerState.showQuantity;
  const geometryModeObjectOverlays = useMemo(
    () =>
      geometryAuthoringShowPrimitives
        ? ctx.objectOverlays.filter((overlay) => visibleObjectIds.includes(overlay.id))
        : [],
    [ctx.objectOverlays, geometryAuthoringShowPrimitives, visibleObjectIds],
  );
  const geometryAuthoringMeshStatus = useMemo(() => {
    if (!geometryAuthoringShowMesh) return "hidden";
    if (!builderGeometryRealization) return "no-geometry";
    if (!builderMeshSnapshot) return "no-mesh";
    if (builderMeshSnapshot.meshState !== "ready") return "failed";
    if (
      builderMeshSnapshot.sourceGeometryRevision !== builderGeometryRealization.revision ||
      builderMeshDirty
    ) {
      return "stale";
    }
    return "current";
  }, [
    builderGeometryRealization,
    builderMeshDirty,
    builderMeshSnapshot,
    geometryAuthoringShowMesh,
  ]);
  const femLayerRenderState = useMemo(
    () => deriveFemLayerRenderState({
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
  const patchMeshPartViewState = useCallback(
    (partIds: string[], patch: Partial<MeshEntityViewStateMap[string]>) => {
      if (partIds.length === 0) {
        return;
      }
      setMeshEntityViewState((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const partId of partIds) {
          const part = meshParts.find((candidate) => candidate.id === partId);
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
  useEffect(() => {
    const femSubmeshViewportActive =
      Boolean(femMeshData) &&
      (effectiveViewMode === "3D" || effectiveViewMode === "Mesh");
    if (femSubmeshViewportActive) {
      return;
    }
    if (visibleSubmeshSnapshot != null) {
      setVisibleSubmeshSnapshot(null);
    }
  }, [
    effectiveViewMode,
    femMeshData,
    setVisibleSubmeshSnapshot,
    visibleSubmeshSnapshot,
  ]);
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
  const handlePreviewMaxPointsChange = useCallback(
    (nextMaxPoints: number) => void patchDisplay({ max_points: nextMaxPoints }),
    [patchDisplay],
  );
  const handleFemSliceComponentChange = useCallback(
    (nextComponent: "x" | "y" | "z" | "magnitude") => {
      if (previewControlsActive) {
        void patchDisplay(displayPatchFromPreviewComponent(
          nextComponent === "magnitude" ? "3D" : nextComponent,
        ));
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
      if (patch.quantityId) {
        requestDisplayQuantity(patch.quantityId);
      }
      if (patch.component) {
        handleFemSliceComponentChange(patch.component);
      }
      if (patch.axis) {
        setPlane(planeFromSliceAxis(patch.axis));
      }
      if (patch.mode) {
        void patchDisplay({
          slice_mode: patch.mode === "all_layers" ? "all" : patch.mode,
        });
      }
      if (typeof patch.layerIndex === "number") {
        setSliceIndex(patch.layerIndex);
        void patchDisplay({ slice_layer: patch.layerIndex });
      }
      if (patch.colormap) {
        void patchDisplay({ colormap: patch.colormap });
      }
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
  const hasExactScopeSegment = useMemo(
    () => {
      if (!selectedFemObjectId) {
        return false;
      }
      const meshParts = ctx.effectiveFemMesh?.mesh_parts ?? [];
      if (meshParts.length > 0) {
        return meshParts.some(
          (part) => part.role === "magnetic_object" && part.object_id === selectedFemObjectId,
        );
      }
      return (ctx.effectiveFemMesh?.object_segments ?? []).some(
        (segment) => segment.object_id === selectedFemObjectId,
      );
    },
    [ctx.effectiveFemMesh?.mesh_parts, ctx.effectiveFemMesh?.object_segments, selectedFemObjectId],
  );
  const missingExactScopeSegment = Boolean(
    femDiscretization &&
      ctx.femMeshData &&
      ctx.femMeshData.nElements > 0 &&
      selectedFemObjectId &&
      !hasExactScopeSegment,
  );

  const originalUnit = ctx.quantityDescriptor?.unit;
  const isAmField = originalUnit === "A/m";
  const scaleFactor = isAmField ? 4 * Math.PI * 1e-7 : 1.0;

  const scaledGlobalScalarPreview = useMemo(() => {
    if (!globalScalarPreview || scaleFactor === 1.0) return globalScalarPreview;
    return {
      ...globalScalarPreview,
      value: globalScalarPreview.value * scaleFactor,
      unit: "T",
    };
  }, [globalScalarPreview, scaleFactor]);

  const scaledSpatialPreview = useMemo(() => {
    if (!spatialPreview || spatialPreview.spatial_kind !== "grid" || spatialPreview.type !== "2D" || scaleFactor === 1.0) return spatialPreview;
    return {
      ...spatialPreview,
      unit: "T",
      min: spatialPreview.min * scaleFactor,
      max: spatialPreview.max * scaleFactor,
      scalar_field: spatialPreview.scalar_field.map(([x, y, v]) => [x, y, v * scaleFactor] as [number, number, number]),
    };
  }, [spatialPreview, scaleFactor]);

  const scaledVectors = useMemo(() => {
    if (!ctx.selectedVectors || scaleFactor === 1.0) return ctx.selectedVectors;
    const arr = new Float64Array(ctx.selectedVectors.length);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = ctx.selectedVectors[i] * scaleFactor;
    }
    return arr;
  }, [ctx.selectedVectors, scaleFactor]);
  const sliceApiFeatureEnabled =
    ctx.isFemBackend
      ? FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFemSlice2D
      : FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFdmSlice2D;
  const femSliceTopologyReady = !ctx.isFemBackend || Boolean(ctx.femMeshData);
  const shouldUseSliceApi2D =
    ctx.effectiveViewMode === "2D" &&
    sliceApiFeatureEnabled &&
    femSliceTopologyReady;
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
              ctx.requestedPreviewMaxPoints > 0
                ? ctx.requestedPreviewMaxPoints
                : undefined,
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
  const slice2DBaseModel: Slice2DModel = useSlice2DModel({
    display: unifiedSliceDisplaySelection,
    resources: runtimeResourceRevisions,
    capabilities: ctx.domainCapabilities,
    adapterKind: femDiscretization ? "fem" : "fdm",
    planeOptions: slice2DPlaneOptions,
  });
  const slice2DModel = useMemo<Slice2DModel>(() => {
    const toolbar = {
      ...slice2DBaseModel.toolbar,
      ...slice2DToolbarPatch,
    };
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
    if (!slice2D.meta) {
      return null;
    }
    return [slice2D.meta.x_pixels, slice2D.meta.y_pixels];
  }, [slice2D.meta]);
  const hasSliceScalar =
    Boolean(scaledSliceScalar) &&
    Boolean(sliceScalarShape) &&
    (sliceScalarShape?.[0] ?? 0) > 0 &&
    (sliceScalarShape?.[1] ?? 0) > 0;
  const liveRenderDebugData = useMemo(() => ({
    source: ctx.selectedVectorSourceKind,
    fieldDataRevision: ctx.fieldDataRevision,
    fieldDataTimestamp: ctx.fieldDataTimestamp,
    liveFieldSourceStep: ctx.liveFieldSourceStep,
    previewSourceStep: ctx.previewSourceStep,
    effectiveStep: ctx.effectiveStep,
  }), [
    ctx.selectedVectorSourceKind,
    ctx.fieldDataRevision,
    ctx.fieldDataTimestamp,
    ctx.liveFieldSourceStep,
    ctx.previewSourceStep,
    ctx.effectiveStep,
  ]);

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
  const resolvedFemTopologyKey = useMemo(() => {
    const explicitTopologyKey = ctx.femTopologyKey?.trim();
    if (explicitTopologyKey) {
      return explicitTopologyKey;
    }
    const meshGenerationId = scaledFemMeshData?.meshGenerationId?.trim();
    if (meshGenerationId) {
      return `gen:${meshGenerationId}`;
    }
    return null;
  }, [ctx.femTopologyKey, scaledFemMeshData?.meshGenerationId]);
  const viewportFitSeed = useMemo(() => {
    const sampleKey =
      scaledFemMeshData
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


  /* ── Determine which viewport is active ── */
  const isVectorSurface3DActive =
    ctx.effectiveViewMode === "3D" &&
    !femDiscretization &&
    (ctx.isVectorQuantity || hasVectorData) &&
    !globalScalarPreview;
  // Use vector-surface mesh mode only when unstructured mesh topology is unavailable.
  const isVectorSurfaceMeshActive = ctx.effectiveViewMode === "Mesh" && !femDiscretization && !ctx.femMeshData;
  const showVectorSurface3D =
    !showGeometryAuthoringViewport &&
    (isVectorSurface3DActive || isVectorSurfaceMeshActive);
  const vectorSurfaceFieldLabel =
    isVectorSurfaceMeshActive
      ? "Geometry"
      : (ctx.quantityDescriptor?.label ?? scaledSpatialPreview?.quantity ?? ctx.selectedQuantity);
  const vectorSurfaceVectors = isVectorSurface3DActive ? scaledVectors : null;
  const handleVectorSurfaceTransformScopeChange = useCallback(
    (scope: "object" | "texture" | null) => setActiveTransformScope(scope),
    [setActiveTransformScope],
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
      selectedVectorCount: ctx.selectedVectors?.length ?? 0,
    },
    toolbar: {
      clipFlip: ctx.meshClipFlip,
      interactionMode: viewport3DInteractionMode,
      snapEnabled: Boolean(builderSnapSettings.enabled),
      objectViewMode: ctx.objectViewMode,
      vectorsVisible: femDiscretization ? ctx.meshShowArrows : true,
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
    } else if (femDiscretization && (ctx.effectiveViewMode === "3D" || ctx.effectiveViewMode === "Mesh")) {
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
    if (lastViewport3DRolloutSignatureRef.current === viewport3DRolloutRoute.signature) {
      return;
    }
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
                : (ctx.fieldDataRevision != null ? String(ctx.fieldDataRevision) : null),
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
  const resolvedSliceQuantityLabel =
    ctx.quantityDescriptor?.label ?? scaledSpatialPreview?.quantity ?? ctx.selectedQuantity;
  const resolvedFemSliceQuantityLabel = ctx.quantityDescriptor?.label ?? ctx.selectedQuantity;

  const renderUnified2DViewport = ({
    preferFemMesh = Boolean(scaledFemMeshData),
    femQuantityId = ctx.selectedQuantity,
  }: {
    preferFemMesh?: boolean;
    femQuantityId?: string | null;
  } = {}): React.ReactNode => {
    return (
      <UnifiedViewport2DPresenter
        slice2DModel={slice2DModel}
        workspaceSelection={workspaceSelection}
        workspaceSync={workspaceSyncState}
        onSlice2DToolbarChange={handleSlice2DToolbarChange}
        shouldUseSliceApi2D={shouldUseSliceApi2D}
        hasSliceScalar={hasSliceScalar}
        sliceLoading={slice2D.loading}
        sliceErrorMessage={slice2D.error?.message ?? null}
        grid={ctx.previewGrid}
        vectors={scaledVectors}
        sliceScalarValues={scaledSliceScalar}
        sliceScalarShape={sliceScalarShape}
        quantityLabel={resolvedSliceQuantityLabel}
        quantityId={sliceQuantityId}
        component={sliceComponent}
        plane={ctx.plane}
        sliceIndex={ctx.sliceIndex}
        preferFemMesh={preferFemMesh}
        femMeshData={scaledFemMeshData}
        femQuantityLabel={resolvedFemSliceQuantityLabel}
        femQuantityId={femQuantityId ?? undefined}
        femQuantityUnit={ctx.quantityDescriptor?.unit ?? undefined}
        femQuantityOptions={femQuantityOptions}
        femComponent={ctx.effectiveVectorComponent}
        meshParts={ctx.meshParts}
        meshEntityViewState={ctx.meshEntityViewState}
        airSegmentVisible={ctx.airMeshVisible}
        objectViewMode={ctx.objectViewMode}
        visibleObjectIds={visibleObjectIds}
        vectorDomainFilter={ctx.femVectorDomainFilter}
        clipAxis={ctx.meshClipAxis}
        clipPos={ctx.meshClipPos}
        antennaOverlays={ctx.antennaOverlays}
        selectedAntennaId={selectedAntennaName}
        showArrows={femShowArrowsForRender}
        previewMaxPoints={ctx.requestedPreviewMaxPoints}
        onQuantityChange={ctx.requestDisplayQuantity}
        onComponentChange={handleFemSliceComponentChange}
        onPlaneChange={ctx.setPlane}
        onClipAxisChange={ctx.setMeshClipAxis}
        onClipPosChange={ctx.setMeshClipPos}
        onShowArrowsChange={ctx.setMeshShowArrows}
        onPreviewMaxPointsChange={handlePreviewMaxPointsChange}
      />
    );
  };

  /* ── Determine what goes into the conditional slot ── */
  let conditionalContent: React.ReactNode = null;

  if (minimalViewportSelectionPath) {
    if (ctx.femMeshData) {
      conditionalContent = (
        <ViewportErrorBoundary label="Minimal FEM Wireframe Viewport">
          <FemMeshView3D
            topologyKey={requireFemTopologyKey(resolvedFemTopologyKey)}
            meshData={scaledFemMeshData ?? ctx.femMeshData}
            selectedSidebarNodeId={ctx.selectedSidebarNodeId}
            viewportFitSeed={viewportFitSeed}
            colorField="none"
            toolbarMode={femToolbarMode}
            renderMode={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe ? "wireframe" : ctx.meshRenderMode}
            opacity={1}
            clipEnabled={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip ? false : ctx.meshClipEnabled}
            clipAxis={ctx.meshClipAxis}
            clipPos={ctx.meshClipPos}
            clipFlip={ctx.meshClipFlip}
            showArrowsRequested={false}
            showOrientationLegend={false}
            worldExtent={ctx.worldExtent}
            worldCenter={ctx.worldCenter}
            partExplorerOpen={selectedSubmeshesToolboxOpen}
            onTogglePartExplorer={openSelectedSubmeshesToolbox}
            legendOpen={ctx.viewportLegendVisible}
            onLegendOpenChange={ctx.setViewportLegendVisible}
            onVisibleSubmeshSnapshotChange={ctx.setVisibleSubmeshSnapshot}
          />
        </ViewportErrorBoundary>
      );
    } else if (
      FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableBoundsPreview &&
      femObjectOverlaysForRender.length > 0
    ) {
      conditionalContent = renderHostedFemBoundsViewport("Mesh");
    } else {
      conditionalContent = (
        <div className="flex h-full w-full items-center justify-center opacity-70">
          <EmptyState
            title="Minimal Diagnostic View"
            description="Aktywny jest tymczasowy tryb diagnostyczny frontendu. Pozostawiono tylko prosty viewport."
            tone="info"
            compact
          />
        </div>
      );
    }
  } else if (
    globalScalarPreview &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGlobalScalarCard
  ) {
    conditionalContent = (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="flex min-w-[280px] max-w-[520px] flex-col gap-4 rounded-2xl border border-border/50 bg-card/70 p-8 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur">
          <div className="space-y-1">
            <p className="text-[0.68rem] font-semibold uppercase tracking-widest text-muted-foreground">
              Global Scalar
            </p>
            <h3 className="text-base font-semibold text-foreground">
              {ctx.quantityDescriptor?.label ?? scaledGlobalScalarPreview!.quantity}
            </h3>
          </div>
          <div className="font-mono text-lg font-medium tracking-tight text-foreground">
            {fmtExp(scaledGlobalScalarPreview!.value)}
          </div>
          <div className="flex flex-wrap gap-3 text-[0.72rem] text-muted-foreground">
            <span>{scaledGlobalScalarPreview!.unit}</span>
            <span>step {scaledGlobalScalarPreview!.source_step.toLocaleString()}</span>
            <span>{fmtSI(scaledGlobalScalarPreview!.source_time, "s")}</span>
          </div>
        </div>
      </div>
    );
  } else if (!ctx.isVectorQuantity && !hasVectorData && !ctx.femMeshData) {
    conditionalContent = (
      <div className="flex flex-col items-center justify-center h-full w-full opacity-60">
        <EmptyState
          title={ctx.quantityDescriptor?.label ?? "Scalar quantity"}
          description={
            ctx.selectedScalarValue !== null
              ? `Latest: ${ctx.selectedScalarValue.toExponential(4)} ${ctx.quantityDescriptor?.unit ?? ""}`
              : "Scalar — see Scalars in sidebar."
          }
          tone="info"
          compact
        />
      </div>
    );
  } else if (
    scaledSpatialPreview &&
    scaledSpatialPreview.spatial_kind === "grid" &&
    scaledSpatialPreview.type === "2D" &&
    scaledSpatialPreview.scalar_field.length > 0 &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGridScalar2D
  ) {
    conditionalContent = (
      <PreviewScalarField2D
        data={scaledSpatialPreview.scalar_field}
        grid={scaledSpatialPreview.preview_grid}
        quantityLabel={ctx.quantityDescriptor?.label ?? scaledSpatialPreview.quantity}
        quantityUnit={scaledSpatialPreview.unit}
        component={scaledSpatialPreview.component}
        min={scaledSpatialPreview.min}
        max={scaledSpatialPreview.max}
        axisExtent={
          ctx.worldExtent
            ? {
                x: ctx.worldCenter
                  ? [
                      ctx.worldCenter[0] - ctx.worldExtent[0] * 0.5,
                      ctx.worldCenter[0] + ctx.worldExtent[0] * 0.5,
                    ]
                  : [0, ctx.worldExtent[0]],
                y: ctx.worldCenter
                  ? [
                      ctx.worldCenter[1] - ctx.worldExtent[1] * 0.5,
                      ctx.worldCenter[1] + ctx.worldExtent[1] * 0.5,
                    ]
                  : [0, ctx.worldExtent[1]],
                unit: "m",
              }
            : null
        }
      />
    );
  }

  const renderHostedGeometryAuthoringViewport = () => (
    <Viewport3DHost
      model={hostedMixedViewportModel}
      mode="3D"
      discretization="mixed"
    >
      <div className="relative h-full w-full">
        <UnifiedViewport3DVectorSurface
          boundaryLabel="Hosted Geometry Authoring Viewport"
          vectorFieldProps={{
            grid: ctx.previewGrid,
            vectors: geometryAuthoringShowQuantity ? scaledVectors : null,
            fieldLabel: geometryAuthoringShowQuantity
              ? (ctx.quantityDescriptor?.label ?? ctx.selectedQuantity)
              : "Geometry Authoring",
            liveRenderDebugData,
            geometryMode: true,
            activeMask: null,
            worldExtent: ctx.worldExtent,
            objectOverlays: geometryModeObjectOverlays,
            selectedObjectId: viewportSelectedObjectId,
            universeCenter: ctx.worldCenter,
            objectViewMode: ctx.objectViewMode,
            onRequestObjectSelect: handleRequestObjectSelect,
            onGeometryTranslate: ctx.applyGeometryTranslation,
            viewport3DModel: hostedMixedViewportModel,
            authoringOverlay: (
              <BuilderViewportLayer
                showPrimitives={geometryAuthoringShowPrimitives}
                showMeshPreview={geometryAuthoringShowMesh}
              />
            ),
            toolbarMode: vectorToolbarMode,
            viewportVisible: true,
          }}
        />
        <div
          className="pointer-events-none absolute left-3 top-3 z-20 rounded-md border border-border/50 bg-background/75 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur"
          style={VIEWPORT_BADGE_STYLE}
        >
          Geometry Mode
          <span className="ml-2">
            primitives:{geometryAuthoringShowPrimitives ? "on" : "off"} · mesh:
            {geometryAuthoringMeshStatus} · quantity:
            {geometryAuthoringShowQuantity ? "on" : "off"}
          </span>
        </div>
        {!unifiedToolbarEnabled ? (
          <GeometryToolbar className="pointer-events-auto absolute bottom-4 left-1/2 z-20 -translate-x-1/2" />
        ) : null}
      </div>
    </Viewport3DHost>
  );

  function renderHostedFemBoundsViewport(mode: "3D" | "Mesh") {
    return (
      <Viewport3DHost
        model={hostedFemBoundsViewportModel}
        mode={mode}
        discretization="fem"
      >
        <UnifiedViewport3DVectorSurface
          boundaryLabel="Hosted FEM Bounds Fallback Viewport"
          vectorFieldProps={{
            grid: ctx.previewGrid,
            vectors: null,
            fieldLabel: "Bounds Preview",
            geometryMode: true,
            activeMask: null,
            worldExtent: ctx.worldExtent,
            objectOverlays: femObjectOverlaysForRender,
            selectedObjectId: selectedFemObjectId,
            universeCenter: ctx.worldCenter,
            focusObjectRequest: ctx.focusObjectRequest,
            objectViewMode: ctx.objectViewMode,
            onRequestObjectSelect: handleRequestObjectSelect,
            viewport3DModel: hostedFemBoundsViewportModel,
            toolbarMode: vectorToolbarMode,
            viewportVisible: true,
          }}
        />
      </Viewport3DHost>
    );
  }

  const renderHostedFemMeshViewport = () => {
    if (!ctx.femMeshData) {
      if (
        showFemBoundsPreview &&
        FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableBoundsPreview
      ) {
        return renderHostedFemBoundsViewport("Mesh");
      }
      return (
        <div className="flex h-full w-full items-center justify-center opacity-80">
          <EmptyState
            title="Mesh topology unavailable"
            description="Build FEM mesh to render Mesh workspace."
            tone="info"
          />
        </div>
      );
    }
    return (
      <Viewport3DHost model={hostedFemViewportModel} mode="Mesh" discretization="fem">
        <ViewportErrorBoundary label="Hosted FEM Mesh Viewport">
          <FemMeshView3D
            topologyKey={requireFemTopologyKey(resolvedFemTopologyKey)}
            meshData={scaledFemMeshData!}
            selectedSidebarNodeId={ctx.selectedSidebarNodeId}
            viewportFitSeed={viewportFitSeed}
            quantityId={ctx.requestedPreviewQuantity}
            quantityOptions={femQuantityOptions}
            colorField="none"
            toolbarMode={femToolbarMode}
            renderMode={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe ? "wireframe" : ctx.meshRenderMode}
            opacity={femOpacityForRender}
            clipEnabled={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip ? false : ctx.meshClipEnabled}
            clipAxis={ctx.meshClipAxis}
            clipPos={ctx.meshClipPos}
            clipFlip={ctx.meshClipFlip}
            previewMaxPoints={ctx.requestedPreviewMaxPoints}
            onRenderModeChange={ctx.setMeshRenderMode}
            onOpacityChange={ctx.setMeshOpacity}
            onClipEnabledChange={ctx.setMeshClipEnabled}
            onClipAxisChange={ctx.setMeshClipAxis}
            onClipPosChange={ctx.setMeshClipPos}
            onClipFlipChange={ctx.setMeshClipFlip}
            onPreviewMaxPointsChange={handlePreviewMaxPointsChange}
            onSelectionChange={ctx.setMeshSelection}
            onRefine={ctx.handleLassoRefine}
            antennaOverlays={ctx.antennaOverlays}
            selectedAntennaId={selectedAntennaName}
            objectOverlays={femObjectOverlaysForRender}
            selectedObjectId={selectedFemObjectId}
            selectedEntityId={ctx.selectedEntityId}
            focusedEntityId={ctx.focusedEntityId}
            objectViewMode={ctx.objectViewMode}
            objectSegments={ctx.effectiveFemMesh?.object_segments ?? []}
            meshParts={ctx.meshParts}
            elementMarkers={ctx.effectiveFemMesh?.element_markers ?? null}
            perDomainQuality={ctx.effectiveFemMesh?.per_domain_quality ?? null}
            meshEntityViewState={ctx.meshEntityViewState}
            onMeshPartViewStatePatch={patchMeshPartViewState}
            visibleObjectIds={visibleObjectIds}
            airSegmentVisible={ctx.airMeshVisible}
            airSegmentOpacity={ctx.airMeshOpacity}
            focusObjectRequest={ctx.focusObjectRequest}
            onAntennaTranslate={ctx.applyAntennaTranslation}
            worldExtent={ctx.worldExtent}
            worldCenter={ctx.worldCenter}
            onEntitySelect={ctx.setSelectedEntityId}
            onEntityFocus={ctx.setFocusedEntityId}
            onQuantityChange={ctx.requestDisplayQuantity}
            activeTextureTransform={activeTextureTransform}
            textureGizmoMode={activeTextureGizmoMode}
            activeTexturePreviewProxy={activeTexturePreviewProxy}
            activeTransformScope={ctx.activeTransformScope}
            onTextureTransformChange={applyTextureTransform}
            onTextureTransformCommit={applyTextureTransform}
            partExplorerOpen={selectedSubmeshesToolboxOpen}
            onTogglePartExplorer={openSelectedSubmeshesToolbox}
            legendOpen={ctx.viewportLegendVisible}
            onLegendOpenChange={ctx.setViewportLegendVisible}
            onVisibleSubmeshSnapshotChange={ctx.setVisibleSubmeshSnapshot}
          />
        </ViewportErrorBoundary>
      </Viewport3DHost>
    );
  };

  const renderHostedFem3DViewport = () => {
    if (!ctx.femMeshData) {
      if (
        showFemBoundsPreview &&
        FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableBoundsPreview
      ) {
        return renderHostedFemBoundsViewport("3D");
      }
      return (
        <div className="flex h-full w-full items-center justify-center opacity-80">
          <EmptyState
            title="FEM 3D preview unavailable"
            description="Build FEM mesh topology to enable 3D field rendering."
            tone="info"
          />
        </div>
      );
    }
    return (
      <Viewport3DHost
        model={hostedFemViewportModel}
        mode="3D"
        discretization="fem"
      >
        <ViewportErrorBoundary label="Hosted Unified 3D Viewport">
          <FemMeshView3D
            topologyKey={requireFemTopologyKey(resolvedFemTopologyKey)}
            meshData={scaledFemMeshData!}
            selectedSidebarNodeId={ctx.selectedSidebarNodeId}
            viewportFitSeed={viewportFitSeed}
            fieldLabel={ctx.quantityDescriptor?.label ?? ctx.selectedQuantity}
            liveRenderDebugData={femLiveRenderDebugData}
            quantityId={ctx.requestedPreviewQuantity}
            quantityOptions={femQuantityOptions}
            toolbarMode={femToolbarMode}
            colorField={femColorFieldForRender}
            showOrientationLegend={ctx.femMagnetization3DActive}
            renderMode={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe ? "wireframe" : ctx.meshRenderMode}
            opacity={femOpacityForRender}
            clipEnabled={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip ? false : ctx.meshClipEnabled}
            clipAxis={ctx.meshClipAxis}
            clipPos={ctx.meshClipPos}
            clipFlip={ctx.meshClipFlip}
            showArrowsRequested={femShowArrowsForRender}
            arrowColorMode={ctx.femArrowColorMode}
            arrowMonoColor={ctx.femArrowMonoColor}
            arrowAlpha={ctx.femArrowAlpha}
            arrowLengthScale={ctx.femArrowLengthScale}
            arrowThickness={ctx.femArrowThickness}
            vectorDomainFilter={ctx.femVectorDomainFilter}
            ferromagnetVisibilityMode={ctx.femFerromagnetVisibilityMode}
            previewMaxPoints={ctx.requestedPreviewMaxPoints}
            onRenderModeChange={ctx.setMeshRenderMode}
            onOpacityChange={ctx.setMeshOpacity}
            onClipEnabledChange={ctx.setMeshClipEnabled}
            onClipAxisChange={ctx.setMeshClipAxis}
            onClipPosChange={ctx.setMeshClipPos}
            onClipFlipChange={ctx.setMeshClipFlip}
            onShowArrowsChange={ctx.setMeshShowArrows}
            onArrowColorModeChange={ctx.setFemArrowColorMode}
            onArrowMonoColorChange={ctx.setFemArrowMonoColor}
            onArrowAlphaChange={ctx.setFemArrowAlpha}
            onArrowLengthScaleChange={ctx.setFemArrowLengthScale}
            onArrowThicknessChange={ctx.setFemArrowThickness}
            onVectorDomainFilterChange={ctx.setFemVectorDomainFilter}
            onFerromagnetVisibilityModeChange={ctx.setFemFerromagnetVisibilityMode}
            onPreviewMaxPointsChange={handlePreviewMaxPointsChange}
            onSelectionChange={ctx.setMeshSelection}
            antennaOverlays={ctx.antennaOverlays}
            selectedAntennaId={selectedAntennaName}
            objectOverlays={femObjectOverlaysForRender}
            selectedObjectId={selectedFemObjectId}
            selectedEntityId={ctx.selectedEntityId}
            focusedEntityId={ctx.focusedEntityId}
            objectViewMode={ctx.objectViewMode}
            objectSegments={ctx.effectiveFemMesh?.object_segments ?? []}
            meshParts={ctx.meshParts}
            elementMarkers={ctx.effectiveFemMesh?.element_markers ?? null}
            perDomainQuality={ctx.effectiveFemMesh?.per_domain_quality ?? null}
            meshEntityViewState={ctx.meshEntityViewState}
            onMeshPartViewStatePatch={patchMeshPartViewState}
            visibleObjectIds={visibleObjectIds}
            airSegmentVisible={ctx.airMeshVisible}
            airSegmentOpacity={ctx.airMeshOpacity}
            focusObjectRequest={ctx.focusObjectRequest}
            onAntennaTranslate={ctx.applyAntennaTranslation}
            worldExtent={ctx.worldExtent}
            worldCenter={ctx.worldCenter}
            onQuantityChange={ctx.requestDisplayQuantity}
            activeTextureTransform={activeTextureTransform}
            textureGizmoMode={activeTextureGizmoMode}
            activeTexturePreviewProxy={activeTexturePreviewProxy}
            activeTransformScope={ctx.activeTransformScope}
            onTextureTransformChange={applyTextureTransform}
            onTextureTransformCommit={applyTextureTransform}
            partExplorerOpen={selectedSubmeshesToolboxOpen}
            onTogglePartExplorer={openSelectedSubmeshesToolbox}
            onVisibleSubmeshSnapshotChange={ctx.setVisibleSubmeshSnapshot}
          />
        </ViewportErrorBoundary>
      </Viewport3DHost>
    );
  };

  const renderHostedVectorSurfaceViewport = () => (
    <Viewport3DHost
      model={hostedVectorSurfaceViewportModel}
      mode={isVectorSurfaceMeshActive ? "Mesh" : "3D"}
      discretization="fdm"
    >
      <UnifiedViewport3DVectorSurface
        boundaryLabel="Hosted Unified 3D Viewport"
        vectorFieldProps={{
          ...vectorSurfaceSharedProps,
          viewport3DModel: hostedVectorSurfaceViewportModel,
          vectors: vectorSurfaceVectors,
          toolbarMode: vectorToolbarMode,
          viewportVisible: true,
        }}
      />
    </Viewport3DHost>
  );

  const graphHostedContent =
    !minimalViewportSelectionPath &&
    !globalScalarPreview &&
    !(spatialPreview &&
      spatialPreview.spatial_kind === "grid" &&
      spatialPreview.type === "2D" &&
      spatialPreview.scalar_field.length > 0 &&
      FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGridScalar2D)
      ? (
          <ViewportHost
            context={{
              viewportMode: effectiveViewMode,
              hasSessionData: Boolean(
                  ctx.selectedVectors?.length ||
                  ctx.preview ||
                  ctx.femMeshData ||
                  showVectorSurface3D ||
                  showGeometryAuthoringViewport ||
                  showFemBoundsPreview ||
                  (ctx.effectiveViewMode === "3D" && Boolean(femDiscretization)),
              ),
              hasFemMesh: Boolean(ctx.femMeshData),
              selectedResultNodeId: graphViewportResultNodeId,
              discretization: femDiscretization ? "fem" : "fdm",
            }}
            selection={{
              selectedObjectId: viewportSelectedObjectId,
              selectedEntityId: ctx.selectedEntityId,
              focusedEntityId: ctx.focusedEntityId,
              selectedSidebarNodeId: ctx.selectedSidebarNodeId,
              objectViewMode: ctx.objectViewMode,
            }}
            selectionActions={{
              onObjectSelect: (objectId) => {
                if (objectId) {
                  handleRequestObjectSelect(objectId);
                  return;
                }
                ctx.setSelectedObjectId(null);
              },
              onEntitySelect: ctx.setSelectedEntityId,
              onEntityFocus: ctx.setFocusedEntityId,
              onSidebarNodeSelect: (nodeId) => ctx.setSelectedSidebarNodeId(nodeId),
              onObjectViewModeChange: ctx.setObjectViewMode,
            }}
            overlays={{
              telemetryHudVisible: FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showTelemetryHud,
              overlays: [
                { id: "telemetry", kind: "telemetry-hud", visible: FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showTelemetryHud },
              ],
            }}
            diagnosticFlags={{
              useMinimalViewportSelectionPath: FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.useMinimalViewportSelectionPath,
              enableGlobalScalarCard: FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGlobalScalarCard,
              enableGridScalar2D: FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGridScalar2D,
              enableUnifiedViewport3D: FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableUnifiedViewport3D,
              enableUnifiedViewportToolbar: FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableUnifiedViewportToolbar,
              enableSlice2D:
                FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFemSlice2D ||
                FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFdmSlice2D,
              femViewportShowToolbar: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showToolbar,
              femViewportForceWireframe: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe,
              femViewportForceDisableClip: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip,
              viewport3dStages,
            }}
            renderComponent={(componentKey) => {
              switch (componentKey) {
                case "UnifiedViewport3D":
                  {
                    const viewport3D = (
                      <UnifiedViewport3DRenderer
                        showGeometryAuthoringViewport={showGeometryAuthoringViewport}
                        isFemMeshMode={ctx.effectiveViewMode === "Mesh" && femDiscretization}
                        isFem3DMode={Boolean(femDiscretization && ctx.effectiveViewMode === "3D")}
                        renderGeometryAuthoring={renderHostedGeometryAuthoringViewport}
                        renderFemMesh={renderHostedFemMeshViewport}
                        renderFem3D={renderHostedFem3DViewport}
                        renderFdm={renderHostedVectorSurfaceViewport}
                      />
                    );
	                    return ctx.effectiveViewMode === "Mesh" && effectiveMeshWorkspaceModel ? (
	                      <MeshWorkspaceShell
	                        model={effectiveMeshWorkspaceModel}
	                        selection={workspaceSelection}
	                        sync={workspaceSyncState}
	                        onBuild={handleMeshWorkspaceBuild}
	                        onToolbarChange={handleMeshWorkspaceToolbarChange}
	                      >
                        {viewport3D}
                      </MeshWorkspaceShell>
                    ) : viewport3D;
                  }
                case "UnifiedViewport2D":
                  return renderUnified2DViewport({
                    preferFemMesh: Boolean(scaledFemMeshData),
                    femQuantityId: ctx.selectedQuantity,
                  });
                case "AnalyzeViewport":
                  return <AnalyzeViewport />;
                case "ResultChartViewport":
                  return <ResultNodeViewport mode="chart" />;
                case "ResultTableViewport":
                  return <ResultNodeViewport mode="table" />;
                case "ResultReportViewport":
                  return <ResultNodeViewport mode="report" />;
                default:
                  return null;
              }
            }}
            fallback={
              <div className="flex flex-col items-center justify-center h-full w-full opacity-60">
                <EmptyState
                  title={ctx.emptyStateMessage.title}
                  description={ctx.emptyStateMessage.description}
                  tone="info"
                />
              </div>
            }
          />
        )
      : null;
  return (
    <div className="flex flex-col flex-1 h-full min-h-0 min-w-0 relative overflow-hidden [&>*]:min-w-0 [&>*]:min-h-0 [&>*:not(.viewportOverlay)]:flex-1 [&>*:not(.viewportOverlay)]:w-full">
      {FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showAntennaPreviewBadge && antennaPreviewBadgeVisible ? (
        <div
          className="viewportOverlay absolute right-4 top-4 rounded-full border border-primary/30 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-primary shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md"
          style={VIEWPORT_BADGE_STYLE}
        >
          physics 2.5D · preview extruded
        </div>
      ) : null}
      {FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showFemSelectionBadges && femDiscretization ? (
        <div
          className="viewportOverlay absolute right-4 top-14 flex items-center gap-2"
          style={VIEWPORT_BADGE_STYLE}
        >
          {ctx.selectedMeshPart || selectedFemObjectId ? (
            <div className="pointer-events-auto flex overflow-hidden rounded-full border border-border/40 bg-background/85 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
              <button
                type="button"
                className={cn(
                  "px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] transition-colors",
                  ctx.objectViewMode === "context"
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
                onClick={() => ctx.setObjectViewMode("context")}
              >
                Context
              </button>
              <button
                type="button"
                className={cn(
                  "px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] transition-colors",
                  ctx.objectViewMode === "isolate"
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
                onClick={() => ctx.setObjectViewMode("isolate")}
              >
                Isolate
              </button>
            </div>
          ) : null}
          {selectedFemObjectId ? (
            <button
              type="button"
              className="pointer-events-auto rounded-full border border-warning/30 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-warning shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md transition-colors hover:bg-warning/20"
              onClick={() => {
                ctx.handleViewModeChange("3D");
                ctx.requestFocusObject(selectedFemObjectId);
              }}
            >
              Focus {selectedFemObjectId}
            </button>
          ) : null}
          {ctx.selectedMeshPart ? (
            <div className="pointer-events-auto rounded-full border border-warning/30 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-warning shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
              {ctx.selectedMeshPart.role === "air"
                ? "Airbox Selected"
                : ctx.selectedMeshPart.label || ctx.selectedMeshPart.id}
            </div>
          ) : null}
          {ctx.focusedMeshPart ? (
            <div className="pointer-events-auto rounded-full border border-primary/30 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-primary shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
              Part: {ctx.focusedMeshPart.label || ctx.focusedMeshPart.id}
            </div>
          ) : null}
          {missingExactScopeSegment ? (
            <div className="pointer-events-auto rounded-full border border-destructive/30 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-destructive shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
              Missing exact object segmentation
            </div>
          ) : null}
        </div>
      ) : FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showFdmSelectionBadges && viewportSelectedObjectId ? (
        <div
          className="viewportOverlay absolute right-4 top-14 flex items-center gap-2"
          style={VIEWPORT_BADGE_STYLE}
        >
          <button
            type="button"
            className="pointer-events-auto rounded-full border border-warning/30 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-warning shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md transition-colors hover:bg-warning/20"
            onClick={() => {
              ctx.handleViewModeChange("3D");
              ctx.requestFocusObject(viewportSelectedObjectId);
            }}
          >
            Focus {viewportSelectedObjectId}
          </button>
          <div className="pointer-events-auto flex overflow-hidden rounded-full border border-border/40 bg-background/85 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
            <button
              type="button"
              className={cn(
                "px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] transition-colors",
                ctx.objectViewMode === "context"
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
              onClick={() => ctx.setObjectViewMode("context")}
            >
              Context
            </button>
            <button
              type="button"
              className={cn(
                "px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] transition-colors",
                ctx.objectViewMode === "isolate"
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
              onClick={() => ctx.setObjectViewMode("isolate")}
            >
              Isolate
            </button>
          </div>
          <div className="pointer-events-auto rounded-full border border-border/40 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
            {selectedObjectOverlay?.source === "mesh_parts"
              ? "Mesh Part"
              : "Object Segment"}
          </div>
        </div>
      ) : null}

      {/* ── Graph-hosted path or fallback content ── */}
      {graphHostedContent ?? conditionalContent}
    </div>
  );
});

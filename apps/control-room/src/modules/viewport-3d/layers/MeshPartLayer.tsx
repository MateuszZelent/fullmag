"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useId, useMemo, memo, useRef, useLayoutEffect } from "react";
import { BufferAttribute, BufferGeometry, type MeshBasicMaterial, type MeshLambertMaterial, type MeshStandardMaterial } from "three";
import { RENDER_POLICIES, materialPolicyProps } from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import type { ModeCompositionFieldLayerSnapshot } from "@/kernel/visualization/ModeCompositionFieldLayerController";
import {
  viewport3DFieldColorLayersEnabledFromBrowserConfig,
  viewport3DVectorLayersEnabledFromBrowserConfig,
} from "@/kernel/browserFullmagConfig";

import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import { resolveMeshPartBounds, selectionForMeshPart, type Viewport3DMeshPart, type Viewport3DPartSelection } from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import { canApplyVertexScalarColorBuffer } from "../viewport3dGeometryColors";
import { useViewport3DGeometryUpload } from "../hooks/useViewport3DGeometryUpload";
import { Viewport3DInteractionWireframe } from "./Viewport3DInteractionWireframe";
import { useViewport3DScalarColorUpload, useViewport3DScalarShaderColorUpload } from "../hooks/useViewport3DScalarColorUpload";
import { type ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DMagnetizationTexturePreview } from "../viewport3dPrimitiveModel";
import { createViewport3DIndexedPointGeometry } from "../viewport3dPointGeometry";
import { attachViewport3DSharedTopologyPosition } from "../viewport3dSharedTopologyPositions";
import { canApplyScalarShaderColorBuffer, applyScalarSurfaceMaterialPolicy, scalarSurfaceShaderVariantKey, updateScalarSurfaceShaderMaterial } from "../viewport3dScalarSurfaceShader";
import type { Viewport3DFieldRenderModel, Viewport3DTopologyPartRenderModel, Viewport3DTopologyRenderModel } from "../viewport3dRenderModel";
import { buildViewport3DRenderableMeshPartKey } from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { BoundsBox } from "./BoundsLayers";
import type { LivePhaseUniform } from "@/kernel/visualization/livePhaseUniform";
import { ComplexGlyphPassLayer, ComplexVectorGlyphLayer } from "./ComplexVectorGlyphLayer";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer.model";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { resolveMeshPartSurfaceMaterialPlan } from "./viewport3DSurfaceMaterialPlans";
import { eventIntersectsRegionOverlay } from "./regionOverlayPicking";
import {
  pointColorFromSettings,
  resolveMeshPartMagnetizationTexturePreviewColor,
  resolveMeshPartSurfaceMaterialColor,
  shaderUsesVertexColors,
  surfaceScalarColorModeFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
} from "./viewport3DLayerSettings";
import { resolveViewport3DTargetRenderPlan } from "./viewport3DTargetRenderPlan";
import { resolveViewport3DTargetLayerRequestedSourceIdentity } from "./viewport3DLayerPassInputs";
import { VIEWPORT_3D_PICK_PRIORITY } from "./viewport3DPickPriority";
import type { Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import {
  buildMeshPartSurfaceGeometryUploadKey,
  resolveMeshPartSurfaceGeometryProjection,
} from "./meshPartGeometryPlan";
import {
  buildMeshPartScalarColorRetentionKey,
  resolveMeshPartCommittedScalarColorState,
} from "./meshPartScalarTransition";
import {
  buildModeCompositionScalarColorBuffer,
  buildModeCompositionComplexGlyphInput,
  modeCompositionTargetIdForMeshPart,
  resolveModeCompositionMeshPartRenderPlan,
} from "../model/modeCompositionViewportProjection";
import { createMeshPartSurfaceGeometry, resolveMeshPartWireframeEdgeIndices, resolveMeshPartPointNodeSelection, resolveMeshPartScalarColors, resolveRetainedMeshPartScalarColors, scalarColorBufferMatchesRetainedSettings, recordMeshPartSurfaceAdoption, resolveMeshPartVisibleScalarColorState, resolveMeshPartSurfacePassPolicies, createMeshPartScalarShaderMaterials, resolveMeshPartVectorLayerInput, hasMeshPartRenderableLayer, resolveMeshPartSurfacePickIdentity, MESH_PART_SURFACE_USER_DATA } from "./MeshPartLayer.model";

const MESH_PART_GEOMETRY_UPLOAD_FRAME_BUDGET_MS = 3;

export const MeshPartLayer = memo(function MeshPartLayer({
  adoptionRegistry,
  colors,
  surfaceFallbackColor,
  sessionIdentity,
  vectorColorMode,
  vectorScale,
  fieldModel,
  materialProfile,
  onSelectPart,
  onGeometryReady,
  renderVisible = true,
  partModel,
  magnetizationTexturePreview,
  meshQualityColors,
  modeCompositionId,
  modeCompositionPhase = null,
  modeCompositionSnapshot,
  settings,
  topologyModel,
  tracker,
  vectorStyle,
  onRenderableGeometryChange,
  renderableGeometryStageVisible,
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  colors: Viewport3DColors;
  surfaceFallbackColor?: Viewport3DColors["mesh"];
  sessionIdentity?: SessionResourceIdentity | null;
  vectorColorMode: string;
  vectorScale: number;
  fieldModel: Viewport3DFieldRenderModel | null;
  materialProfile: Viewport3DMaterialProfile;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  onGeometryReady?: (part: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>, ready: boolean) => void;
  renderVisible?: boolean;
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>;
  magnetizationTexturePreview: Viewport3DMagnetizationTexturePreview | null;
  meshQualityColors: ScalarColorBuffer | null;
  modeCompositionId: string | null;
  /** Live phase cell of the modal layer; materials bind it, renders never read it. */
  modeCompositionPhase?: LivePhaseUniform | null;
  modeCompositionSnapshot: ModeCompositionFieldLayerSnapshot | null;
  settings: VisualizationTargetSettings;
  topologyModel: Viewport3DTopologyRenderModel | null;
  tracker: Viewport3DResourceTracker;
  vectorStyle: VectorFieldLayerVectorStyle;
  onRenderableGeometryChange?: (
    renderableGeometryKey: string,
    ready: boolean,
  ) => void;
  renderableGeometryStageVisible: boolean;
}) {
  const invalidate = useBatchedInvalidate();
  const renderSettings = settings;
  const topologyUploadManager = useMemo(
    () =>
      createViewport3DGpuUploadManager({
        policy: {
          targetFrameBudgetMs: MESH_PART_GEOMETRY_UPLOAD_FRAME_BUDGET_MS,
        },
      }),
    [],
  );
  useEffect(() => () => topologyUploadManager.dispose(), [topologyUploadManager]);

  const part = partModel.part;
  const topologyRevision = topologyModel?.meshRevision ?? null;
  const surfaceIndices = partModel.surfaceIndices;
  const surfaceGeometryProjection = resolveMeshPartSurfaceGeometryProjection(
    renderSettings,
  );
  const expandSurfaceFaces = surfaceGeometryProjection !== "indexed";
  const surfaceVertexCount = expandSurfaceFaces
    ? surfaceIndices?.length ?? 0
    : topologyModel?.nodeCount ?? 0;
  const topologyNodeCount = topologyModel?.nodeCount ?? 0;
  const surfaceOwners = useMemo(() => new WeakMap<BufferGeometry, {
    positions: Float32Array;
    indices: Uint32Array | null;
  }>(), []);
  const createSurfaceGeometry = useCallback(() => {
    if (!topologyModel) return null;
    const next = createMeshPartSurfaceGeometry({
      expandSurfaceFaces,
      positions: topologyModel.positions,
      surfaceIndices,
    });
    if (next) surfaceOwners.set(next, { positions: topologyModel.positions, indices: surfaceIndices });
    return next;
  }, [expandSurfaceFaces, surfaceIndices, topologyModel, surfaceOwners]);
  const geometry = useViewport3DGeometryUpload({
    createGeometry: createSurfaceGeometry,
    dirtyReason: "mesh-part-surface",
    enabled: Boolean(topologyModel && surfaceIndices?.length),
    estimatedBytes:
      (topologyModel?.positions.byteLength ?? 0) +
      (surfaceIndices?.byteLength ?? 0),
    invalidate,
    itemCount: surfaceIndices?.length ?? 0,
    key: buildMeshPartSurfaceGeometryUploadKey({
      indicesByteLength: surfaceIndices?.byteLength ?? 0,
      partId: part.id,
      positionsByteLength: topologyModel?.positions.byteLength ?? 0,
      projection: surfaceGeometryProjection,
      topologyRevision,
    }),
    lane: "topology-index",
    targetRevision: topologyRevision === null ? null : String(topologyRevision),
    tracker,
    uploadManager: topologyUploadManager,
  });

  const edgeIndices = resolveMeshPartWireframeEdgeIndices(
    renderSettings.wireframeGeometryScope ?? "surface",
    partModel,
    renderSettings.wireframeVisible,
  );
  const createEdgeGeometry = useCallback(() => {
    if (!topologyModel || !edgeIndices) return null;
    const next = new BufferGeometry();
    attachViewport3DSharedTopologyPosition(next, topologyModel.positions);
    next.setIndex(new BufferAttribute(edgeIndices, 1));
    return next;
  }, [edgeIndices, topologyModel]);
  const edgeGeometry = useViewport3DGeometryUpload({
    createGeometry: createEdgeGeometry,
    dirtyReason: "mesh-part-wireframe",
    enabled: Boolean(topologyModel && edgeIndices?.length),
    estimatedBytes:
      (topologyModel?.positions.byteLength ?? 0) + (edgeIndices?.byteLength ?? 0),
    invalidate,
    itemCount: edgeIndices?.length ?? 0,
    key: `mesh-part-wireframe:${part.id}:scope=${renderSettings.wireframeGeometryScope ?? "surface"}:topology=${topologyRevision ?? "none"}:positions=${topologyModel?.positions.byteLength ?? 0}:indices=${edgeIndices?.byteLength ?? 0}`,
    lane: "topology-index",
    targetRevision: topologyRevision === null ? null : String(topologyRevision),
    tracker,
    uploadManager: topologyUploadManager,
  });

  const nodeSelection = resolveMeshPartPointNodeSelection(
    renderSettings.geometryScope,
    partModel,
  );
  const nodeSelectionIndices = meshPartPointSelectionIndices(nodeSelection);
  const createPointGeometry = useCallback(() => {
    if (!renderSettings.pointsVisible) return null;
    if (!topologyModel) return null;
    return createViewport3DIndexedPointGeometry(topologyModel, nodeSelection);
  }, [nodeSelection, renderSettings.pointsVisible, topologyModel]);
  const pointGeometry = useViewport3DGeometryUpload({
    createGeometry: createPointGeometry,
    dirtyReason: "mesh-part-points",
    enabled: Boolean(renderSettings.pointsVisible && topologyModel),
    estimatedBytes:
      (topologyModel?.positions.byteLength ?? 0) +
      (nodeSelectionIndices?.length ?? 0) * Uint32Array.BYTES_PER_ELEMENT,
    invalidate,
    itemCount:
      nodeSelectionIndices?.length ??
      meshPartPointSelectionCount(nodeSelection) ??
      topologyModel?.nodeCount ??
      0,
    key: `mesh-part-points:${part.id}:scope=${renderSettings.geometryScope}:topology=${topologyRevision ?? "none"}:positions=${topologyModel?.positions.byteLength ?? 0}:selection=${meshPartPointSelectionRevision(nodeSelection)}`,
    lane: "topology-index",
    targetRevision: topologyRevision === null ? null : String(topologyRevision),
    tracker,
    uploadManager: topologyUploadManager,
  });

  const fieldColorLayersEnabled =
    viewport3DFieldColorLayersEnabledFromBrowserConfig();
  const baseRenderPlan = resolveViewport3DTargetRenderPlan(
    renderSettings,
    materialProfile,
  );
  const modeTargetId = modeCompositionTargetIdForMeshPart(part);
  const modeRenderPlan = modeTargetId
    ? resolveModeCompositionMeshPartRenderPlan({
        baseSurface: baseRenderPlan.surface.visible
          ? { kind: "surface", surface: baseRenderPlan.surface }
          : { kind: "none" },
        compositionId: modeCompositionId,
        snapshot: modeCompositionSnapshot,
        targetId: modeTargetId,
      })
    : null;
  const modeScalarColors = useMemo(() => {
    const modal = modeRenderPlan?.surfacePass;
    if (modal?.owner !== "modal") return null;
    const requiredSurfaceNodeIndices =
      partModel.surfaceNodeIndices ?? surfaceIndices;
    if (!requiredSurfaceNodeIndices?.length) return null;
    return buildModeCompositionScalarColorBuffer({
      field: modal.buffer.field,
      geometryNodeIndices: expandSurfaceFaces ? surfaceIndices : null,
      identity: modal.buffer.identity,
      layer: modal.buffer.layer,
      phase: modeCompositionPhase,
      projectionKey: [
        part.id,
        surfaceGeometryProjection,
        topologyRevision ?? "none",
      ].join(":"),
      requiredSurfaceNodeIndices,
      topologyNodeCount,
    });
  }, [
    expandSurfaceFaces,
    modeRenderPlan,
    modeCompositionPhase,
    part.id,
    partModel.surfaceNodeIndices,
    surfaceGeometryProjection,
    surfaceIndices,
    topologyNodeCount,
    topologyRevision,
  ]);
  const modalSurfaceActive = Boolean(modeScalarColors);
  // Phase-independent and cached per field and layer appearance; the glyph
  // shader applies the layer phase from modeCompositionPhase.
  const modalLayer =
    modeRenderPlan?.surfacePass.owner === "modal"
      ? modeRenderPlan.surfacePass.buffer.layer
      : null;
  const modalGlyphInput =
    modeRenderPlan?.surfacePass.owner === "modal" && topologyModel
      ? buildModeCompositionComplexGlyphInput({
          field: modeRenderPlan.surfacePass.buffer.field,
          identity: modeRenderPlan.surfacePass.buffer.identity,
          layer: modeRenderPlan.surfacePass.buffer.layer,
          topologyNodeCount,
          topologyPositions: topologyModel.positions,
          vectorScale,
        })
      : null;
  const modalVectorsActive = Boolean(modalGlyphInput);
  const scalarColorMode = fieldColorLayersEnabled
    ? surfaceScalarColorModeFromSettings(renderSettings)
    : null;
  const scalarColorRetentionKey = useMemo(() => {
    if (!renderSettings.shaderVisible) return null;
    if (modeScalarColors) {
      return modeScalarColors.buildKey ?? null;
    }
    if (meshQualityColors) {
      return [
        "mesh-quality",
        `part=${part.id}`,
        `topology=${topologyRevision ?? "none"}`,
        `vertices=${topologyNodeCount}`,
      ].join("|");
    }
    if (!fieldColorLayersEnabled || !scalarColorMode) return null;
    return buildMeshPartScalarColorRetentionKey({
      mode: scalarColorMode,
      partId: part.id,
      projection: surfaceGeometryProjection,
      quantityId: renderSettings.activeQuantityId,
      scalarColorPalette: renderSettings.scalarColorPalette,
      topologyRevision,
      vertexCount: surfaceVertexCount,
    });
  }, [
    fieldColorLayersEnabled,
    modeScalarColors,
    meshQualityColors,
    part.id,
    renderSettings.activeQuantityId,
    renderSettings.scalarColorPalette,
    renderSettings.shaderVisible,
    scalarColorMode,
    surfaceGeometryProjection,
    surfaceVertexCount,
    topologyNodeCount,
    topologyRevision,
  ]);
  const scalarColorsCandidate = resolveMeshPartScalarColors({
    fieldModel,
    partId: part.id,
    scalarColorMode,
    settings: renderSettings,
  });
  const retainedScalarColorsRef = useRef<ScalarColorBuffer | null>(null);
  const scalarColors = resolveRetainedMeshPartScalarColors({
    current: scalarColorsCandidate,
    previous: retainedScalarColorsRef.current,
    scalarColorMode,
    settings: renderSettings,
    topologyRevision,
    vertexCount: surfaceVertexCount,
  });
  useEffect(() => {
    if (
      scalarColorMode &&
      scalarColorBufferMatchesRetainedSettings(
        scalarColorsCandidate,
        scalarColorMode,
        renderSettings,
        topologyRevision,
        surfaceVertexCount,
      )
    ) {
      retainedScalarColorsRef.current = scalarColorsCandidate;
      return;
    }
    if (
      !scalarColorMode ||
      !fieldColorLayersEnabled ||
      !renderSettings.visible ||
      !renderSettings.shaderVisible
    ) {
      retainedScalarColorsRef.current = null;
    }
  }, [
    fieldColorLayersEnabled,
    renderSettings,
    scalarColorMode,
    scalarColorsCandidate,
    surfaceVertexCount,
    topologyRevision,
  ]);
  const effectiveScalarColors = modeScalarColors ?? meshQualityColors ?? scalarColors;
  const vertexColorsEnabled =
    modalSurfaceActive ||
    Boolean(meshQualityColors) ||
    (fieldColorLayersEnabled && shaderUsesVertexColors(renderSettings));
  const effectiveCanUseVertexScalarColors = canApplyVertexScalarColorBuffer(
    effectiveScalarColors,
    surfaceVertexCount,
  );
  const shaderScalarColorsEnabled =
    (modalSurfaceActive || !meshQualityColors) &&
    vertexColorsEnabled &&
    canApplyScalarShaderColorBuffer(
      effectiveScalarColors,
      surfaceVertexCount,
    ) &&
    !effectiveCanUseVertexScalarColors;
  const visibleShaderScalarColors = useViewport3DScalarShaderColorUpload({
    colorBuffer: shaderScalarColorsEnabled ? effectiveScalarColors : null,
    dirtyReason: "field-scalar-shader",
    enabled: Boolean(
      geometry &&
        topologyModel &&
        (modalSurfaceActive || renderSettings.shaderVisible) &&
        (modalSurfaceActive || fieldColorLayersEnabled || meshQualityColors),
    ),
    geometry,
    invalidate,
    retentionKey: scalarColorRetentionKey,
    targetRevision: effectiveScalarColors?.targetRevision ?? null,
    tracker,
    uploadKey:
      effectiveScalarColors?.buildKey ??
      `mesh-part-shader-values:${part.id}:${surfaceVertexCount}`,
    vertexCount: surfaceVertexCount,
  });
  const visibleScalarColors = useViewport3DScalarColorUpload({
    colorBuffer: effectiveScalarColors,
    dirtyReason: meshQualityColors ? "mesh-quality-colors" : "field-colors",
    enabled: Boolean(
      geometry &&
        topologyModel &&
        (modalSurfaceActive || renderSettings.shaderVisible) &&
        (modalSurfaceActive || fieldColorLayersEnabled || meshQualityColors) &&
        !shaderScalarColorsEnabled,
    ),
    geometry,
    invalidate,
    retentionKey: scalarColorRetentionKey,
    targetRevision: effectiveScalarColors?.targetRevision ?? null,
    tracker,
    uploadKey:
      effectiveScalarColors?.buildKey ??
      `mesh-part-colors:${part.id}:${surfaceVertexCount}`,
    vertexColorsEnabled,
    vertexCount: surfaceVertexCount,
  });
  const committedScalarColorState = resolveMeshPartCommittedScalarColorState({
    requestedPipeline: shaderScalarColorsEnabled ? "shader" : "vertex",
    visibleShaderColors: visibleShaderScalarColors,
    visibleVertexColors: visibleScalarColors,
  });
  const adoptedScalarColors = committedScalarColorState.buffer;
  const requestedFieldBufferId = resolveViewport3DTargetLayerRequestedSourceIdentity({
    fieldModel,
    partId: part.id,
  }).fieldBufferId;
  const adoptionOwnerId = `mesh-part-surface:${useId()}`;
  useEffect(() => {
    if (!adoptionRegistry || meshQualityColors || !adoptedScalarColors) return;
    let adoption = recordMeshPartSurfaceAdoption({
      carrierId: part.id,
      fieldBufferId: requestedFieldBufferId,
      ownerId: adoptionOwnerId,
      registry: adoptionRegistry,
      sessionIdentity,
      scalarBuffer: adoptedScalarColors,
    });
    const replay = () => {
      adoption = recordMeshPartSurfaceAdoption({
        carrierId: part.id,
        fieldBufferId: requestedFieldBufferId,
        ownerId: adoptionOwnerId,
        registry: adoptionRegistry,
        sessionIdentity,
        scalarBuffer: adoptedScalarColors,
      });
    };
    const unregister = adoptionRegistry.registerCarrierAdoptionReplay(part.id, replay);
    return () => {
      unregister();
      adoptionRegistry.clearAdoption(adoptionOwnerId, adoption);
    };
  }, [
    adoptedScalarColors,
    adoptionOwnerId,
    adoptionRegistry,
    meshQualityColors,
    part.id,
    requestedFieldBufferId,
    sessionIdentity,
  ]);

  const materialRef = useRef<MeshBasicMaterial>(null);
  const materialFrontRef = useRef<MeshBasicMaterial>(null);
  const litMaterialRef = useRef<MeshLambertMaterial>(null);
  const litMaterialFrontRef = useRef<MeshLambertMaterial>(null);
  const standardMaterialRef = useRef<MeshStandardMaterial>(null);
  const standardMaterialFrontRef = useRef<MeshStandardMaterial>(null);
  const { hasScalarColors: hasUploadedVertexScalarColors } =
    resolveMeshPartVisibleScalarColorState({
    effectiveScalarColors,
    meshQualityColors,
    surfaceVertexCount,
    vertexColorsEnabled,
    visibleScalarColors:
      committedScalarColorState.pipeline === "vertex"
        ? committedScalarColorState.buffer
        : null,
  });
  const renderPlan = baseRenderPlan;
  const surfaceOpacity = modalSurfaceActive
    ? Math.min(1, Math.max(0, modeCompositionSnapshot?.layer?.appearance.opacity ?? 1))
    : renderPlan.surface.opacity;
  const surfacePassPolicies = useMemo(
    () => resolveMeshPartSurfacePassPolicies(surfaceOpacity),
    [surfaceOpacity],
  );
  const surfacePolicy = surfacePassPolicies.back;
  const surfacePolicyFront = surfacePassPolicies.front;
  const scalarShaderBuffer = committedScalarColorState.buffer;
  // Stable "program shape" key: null when there is no buffer, otherwise one of 4 strings
  // (scalar/orientation × real/complex). Deliberately does NOT depend on scalarShaderBuffer's
  // identity, phase, range, palette, opacity, or surface policies — those are data / render state,
  // not program shape, and are pushed in place via updateScalarSurfaceShaderMaterial and Object.assign
  // below instead of forcing a new ShaderMaterial (and synchronous GL program relink) on every
  // animation frame (S-08). Both back and front pass materials are tracked for S-14.
  const scalarShaderVariantKey = scalarShaderBuffer
    ? scalarSurfaceShaderVariantKey(scalarShaderBuffer)
    : null;
  const fieldPresentationEnabled = Boolean(materialProfile.magneticSurface.presentation);

  const scalarShaderMaterials = useMemo(
    () =>
      createMeshPartScalarShaderMaterials({
        buffer: scalarShaderBuffer,
        enabled:
          Boolean(modalSurfaceActive || fieldColorLayersEnabled || meshQualityColors) &&
          committedScalarColorState.pipeline === "shader",
        materialProfile: materialProfile.magneticSurface,
        surfaceOpacity: 1,
        surfacePolicy: RENDER_POLICIES.solidSurface,
        surfacePolicyFront: RENDER_POLICIES.contextSurfaceFront,
        tracker,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- S-08/S-14: materials depend strictly on GL program shape (variant key), not per-frame buffer identity, opacity or surface policies
    [
      committedScalarColorState.pipeline,
      fieldColorLayersEnabled,
      fieldPresentationEnabled,
      meshQualityColors,
      modalSurfaceActive,
      scalarShaderVariantKey,
      tracker,
    ],
  );
  const scalarShaderMaterial = scalarShaderMaterials.back;
  const scalarShaderMaterialFront = scalarShaderMaterials.front;
  const surfaceMaterialPlan = resolveMeshPartSurfaceMaterialPlan({
    hasScalarShaderMaterial: Boolean(scalarShaderMaterial),
    hasUploadedVertexScalarColors,
    materialProfile,
  });

  useLayoutEffect(() => {
    // Add normals only for an explicitly lit pass; keep the same geometry and
    // shared topology position buffer when appearance settings change.
    if (!geometry || geometry.getAttribute("normal")) return;
    // Quantitative scalar shaders skip lighting when strength is zero, so they
    // do not need generated normals. Keep normals for explicitly lit geometry.
    const shaderNeedsNormals =
      Boolean(scalarShaderMaterial) &&
      materialProfile.magneticSurface.shadeStrength > 0;
    const uniformSurfaceNeedsNormals =
      surfaceMaterialPlan.kind === "standard" ||
      surfaceMaterialPlan.kind === "lambert";
    if (!shaderNeedsNormals && !uniformSurfaceNeedsNormals) {
      return;
    }
    geometry.computeVertexNormals();
    invalidate();
  }, [
    geometry,
    invalidate,
    materialProfile.magneticSurface.shadeStrength,
    scalarShaderMaterial,
    surfaceMaterialPlan.kind,
  ]);

  useEffect(
    () => () => {
      tracker.release("material", scalarShaderMaterials.back);
      tracker.release("material", scalarShaderMaterials.front);
    },
    [scalarShaderMaterials, tracker],
  );
  useLayoutEffect(() => {
    if (
      committedScalarColorState.pipeline !== "shader" ||
      !committedScalarColorState.buffer
    ) return;
    if (scalarShaderMaterial) {
      updateScalarSurfaceShaderMaterial(
        scalarShaderMaterial,
        committedScalarColorState.buffer,
        surfaceOpacity,
        materialProfile.magneticSurface.shadeStrength,
        materialProfile.magneticSurface.presentation,
      );
      applyScalarSurfaceMaterialPolicy(scalarShaderMaterial, surfacePolicy);
      scalarShaderMaterial.toneMapped =
        materialProfile.magneticSurface.toneMapped ?? false;
    }
    if (scalarShaderMaterialFront) {
      updateScalarSurfaceShaderMaterial(
        scalarShaderMaterialFront,
        committedScalarColorState.buffer,
        surfaceOpacity,
        materialProfile.magneticSurface.shadeStrength,
        materialProfile.magneticSurface.presentation,
      );
      if (surfacePolicyFront) {
        applyScalarSurfaceMaterialPolicy(scalarShaderMaterialFront, surfacePolicyFront);
      }
      scalarShaderMaterialFront.toneMapped =
        materialProfile.magneticSurface.toneMapped ?? false;
    }
    // Imperative uniform changes do not invalidate a demand-driven canvas.
    // Schedule the frame after both surface materials have adopted the palette.
    invalidate();
  }, [
    committedScalarColorState.buffer,
    committedScalarColorState.pipeline,
    invalidate,
    materialProfile.magneticSurface.shadeStrength,
    materialProfile.magneticSurface.toneMapped,
    materialProfile.magneticSurface.presentation,
    scalarShaderMaterial,
    scalarShaderMaterialFront,
    surfaceOpacity,
    surfacePolicy,
    surfacePolicyFront,
  ]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.needsUpdate = true;
    }
    if (litMaterialRef.current) {
      litMaterialRef.current.needsUpdate = true;
    }
    if (materialFrontRef.current) {
      materialFrontRef.current.needsUpdate = true;
    }
    if (litMaterialFrontRef.current) {
      litMaterialFrontRef.current.needsUpdate = true;
    }
    if (standardMaterialRef.current) {
      standardMaterialRef.current.needsUpdate = true;
    }
    if (standardMaterialFrontRef.current) {
      standardMaterialFrontRef.current.needsUpdate = true;
    }
  }, [hasUploadedVertexScalarColors]);

  const vectorLayerInput = resolveMeshPartVectorLayerInput({
    fieldModel,
    partId: part.id,
  });
  const hasAnyVisibleRenderableSubLayer = hasMeshPartRenderableLayer({
    renderPlan,
    surfaceReady: Boolean(geometry),
    wireframeReady: Boolean(edgeGeometry),
    pointsReady: Boolean(pointGeometry),
    vectorsReady: viewport3DVectorLayersEnabledFromBrowserConfig() &&
      Boolean(
        modalGlyphInput ??
          vectorLayerInput.complexGlyphs ??
          vectorLayerInput.segments,
      ),
    modalSurfaceActive,
    modalVectorsActive,
  });

  useLayoutEffect(() => {
    const owner = geometry ? surfaceOwners.get(geometry) : null;
    // Uploaded but suppressed fields cannot replace the field-free preview.
    onGeometryReady?.(partModel, Boolean(hasAnyVisibleRenderableSubLayer && owner &&
      owner.positions === topologyModel?.positions && owner.indices === surfaceIndices));
    return () => onGeometryReady?.(partModel, false);
  }, [geometry, hasAnyVisibleRenderableSubLayer, onGeometryReady, partModel,
    surfaceIndices, surfaceOwners, topologyModel]);
  const hasRenderableSurfaceOrEdgeGeometry =
    renderableGeometryStageVisible &&
    ((renderSettings.visible &&
      (modalSurfaceActive || renderPlan.surface.visible) &&
      Boolean(geometry)) ||
      (renderPlan.wireframe.visible && Boolean(edgeGeometry)));
  useLayoutEffect(() => {
    if (!onRenderableGeometryChange) return undefined;
    onRenderableGeometryChange(
      buildViewport3DRenderableMeshPartKey(
        part.id,
        topologyModel,
        sessionIdentity,
      ),
      hasRenderableSurfaceOrEdgeGeometry,
    );
    return () =>
      onRenderableGeometryChange(
        buildViewport3DRenderableMeshPartKey(
          part.id,
          topologyModel,
          sessionIdentity,
        ),
        false,
      );
  }, [
    hasRenderableSurfaceOrEdgeGeometry,
    onRenderableGeometryChange,
    part.id,
    sessionIdentity,
    topologyModel,
  ]);

  if (
    (!renderSettings.visible && !modalSurfaceActive && !modalVectorsActive) ||
    !hasAnyVisibleRenderableSubLayer
  ) return null;
  const meshColor = resolveMeshPartSurfaceMaterialColor(
    renderSettings,
    surfaceFallbackColor ?? colors.mesh,
    resolveMeshPartMagnetizationTexturePreviewColor(
      Boolean(fieldModel?.legacyResponseOverlayActive || modalSurfaceActive),
      magnetizationTexturePreview?.color ?? null,
    ),
    Boolean(committedScalarColorState.buffer),
  );
  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (eventIntersectsRegionOverlay(event)) return;
    event.stopPropagation();
    const identity = resolveMeshPartSurfacePickIdentity({
      expandedSurfaceFaces: expandSurfaceFaces,
      faceIndex: event.faceIndex,
      part,
      surfaceHit: event.object.userData.viewportMeshPartSurface === true,
      surfaceTriangleCellTypes: partModel.surfaceTriangleCellTypes,
      surfaceTriangleFacetIndices: partModel.surfaceTriangleFacetIndices,
      surfaceTriangleGlobalCellOrdinals:
        partModel.surfaceTriangleGlobalCellOrdinals,
    });
    onSelectPart(
      selectionForMeshPart(
        part,
        identity.boundaryFaceIndex,
        identity.globalCellOrdinal,
        identity.elementFamily,
      ),
    );
  };

  return (
    <group
      visible={renderVisible}
      onPointerDown={handlePointerDown}
      userData={{ viewportSemanticPickPriority: VIEWPORT_3D_PICK_PRIORITY.meshPart }}
    >
      {(modalSurfaceActive || renderPlan.surface.visible) && geometry ? (
        <>
          <mesh
            castShadow={surfaceMaterialPlan.castShadow}
            geometry={geometry}
            receiveShadow={surfaceMaterialPlan.receiveShadow}
            renderOrder={surfacePassPolicies.renderOrderBack}
            userData={MESH_PART_SURFACE_USER_DATA}
          >
            {scalarShaderMaterial ? (
              <primitive attach="material" object={scalarShaderMaterial} />
            ) : surfaceMaterialPlan.kind === "standard" ? (
              <meshStandardMaterial
                ref={standardMaterialRef}
                color={meshColor}
                metalness={surfaceMaterialPlan.metalness}
                opacity={surfaceOpacity}
                roughness={surfaceMaterialPlan.roughness}
                toneMapped={surfaceMaterialPlan.toneMapped}
                vertexColors={hasUploadedVertexScalarColors}
                {...surfacePolicy}
              />
            ) : surfaceMaterialPlan.kind === "lambert" ? (
              <meshLambertMaterial
                ref={litMaterialRef}
                color={meshColor}
                opacity={surfaceOpacity}
                toneMapped={surfaceMaterialPlan.toneMapped}
                vertexColors={hasUploadedVertexScalarColors}
                {...surfacePolicy}
              />
            ) : surfaceMaterialPlan.kind === "basic" ? (
              <meshBasicMaterial
                ref={materialRef}
                color={meshColor}
                opacity={surfaceOpacity}
                toneMapped={surfaceMaterialPlan.toneMapped}
                vertexColors={hasUploadedVertexScalarColors}
                {...surfacePolicy}
              />
            ) : null}
          </mesh>
          {surfacePolicyFront ? (
            <mesh
              castShadow={surfaceMaterialPlan.castShadow}
              geometry={geometry}
              receiveShadow={surfaceMaterialPlan.receiveShadow}
              renderOrder={
                surfacePassPolicies.renderOrderFront ??
                RENDER_POLICIES.contextSurfaceFront.renderOrder
              }
              userData={MESH_PART_SURFACE_USER_DATA}
            >
              {scalarShaderMaterialFront ? (
                <primitive attach="material" object={scalarShaderMaterialFront} />
              ) : surfaceMaterialPlan.kind === "standard" ? (
                <meshStandardMaterial
                  ref={standardMaterialFrontRef}
                  color={meshColor}
                  metalness={surfaceMaterialPlan.metalness}
                  opacity={surfaceOpacity}
                  roughness={surfaceMaterialPlan.roughness}
                  toneMapped={surfaceMaterialPlan.toneMapped}
                  vertexColors={hasUploadedVertexScalarColors}
                  {...surfacePolicyFront}
                />
              ) : surfaceMaterialPlan.kind === "lambert" ? (
                <meshLambertMaterial
                  ref={litMaterialFrontRef}
                  color={meshColor}
                  opacity={surfaceOpacity}
                  toneMapped={surfaceMaterialPlan.toneMapped}
                  vertexColors={hasUploadedVertexScalarColors}
                  {...surfacePolicyFront}
                />
              ) : surfaceMaterialPlan.kind === "basic" ? (
                <meshBasicMaterial
                  ref={materialFrontRef}
                  color={meshColor}
                  opacity={surfaceOpacity}
                  toneMapped={surfaceMaterialPlan.toneMapped}
                  vertexColors={hasUploadedVertexScalarColors}
                  {...surfacePolicyFront}
                />
              ) : null}
            </mesh>
          ) : null}
        </>
      ) : null}
      {renderPlan.wireframe.visible && edgeGeometry ? (
        <Viewport3DInteractionWireframe
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
          surfaceIndices={partModel.edgeIndices}
          tracker={tracker}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(renderSettings, colors.wire)}
            opacity={renderPlan.wireframe.opacity}
            {...materialPolicyProps("featureEdges")}
          />
        </Viewport3DInteractionWireframe>
      ) : null}
      {renderPlan.bounds.visible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={renderPlan.bounds.opacity}
        />
      ) : null}
      {renderPlan.points.visible && pointGeometry ? (
        <points
          geometry={pointGeometry}
          renderOrder={RENDER_POLICIES.points.renderOrder}
        >
          <pointsMaterial
            color={pointColorFromSettings(renderSettings, colors.wire)}
            opacity={renderPlan.points.opacity}
            sizeAttenuation={false}
            size={3}
            {...materialPolicyProps("points")}
          />
        </points>
      ) : null}
      {viewport3DVectorLayersEnabledFromBrowserConfig() &&
      modalGlyphInput &&
      modalLayer ? (
        <ComplexVectorGlyphLayer
          adoptionRegistry={adoptionRegistry}
          carrierId={part.id}
          colorMode="orientation"
          fallbackColor={String(colors.field)}
          fieldBufferId={modalGlyphInput.fieldBufferId}
          glyphs={modalGlyphInput.glyphs}
          opacity={modalLayer.appearance.opacity}
          phase={
            modeCompositionPhase ??
            modalLayer.phase_rad + modalLayer.animation.phase_offset_rad
          }
          sessionIdentity={sessionIdentity}
          style={vectorStyleFromSettings(renderSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : viewport3DVectorLayersEnabledFromBrowserConfig() &&
        renderPlan.vectors.visible &&
        vectorLayerInput.complexGlyphs ? (
        <ComplexGlyphPassLayer
          adoptionRegistry={adoptionRegistry}
          carrierId={part.id}
          fallbackColor={String(colors.field)}
          fieldBufferId={requestedFieldBufferId}
          opacity={renderPlan.vectors.opacity}
          pass={vectorLayerInput.complexGlyphs}
          sessionIdentity={sessionIdentity}
          style={vectorStyleFromSettings(renderSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : viewport3DVectorLayersEnabledFromBrowserConfig() &&
        renderPlan.vectors.visible ? (
        <VectorFieldLayer
          adoptionRegistry={adoptionRegistry}
          buildReference={vectorLayerInput.buildReference}
          carrierId={part.id}
          colors={colors}
          colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
          materialProfile={materialProfile.glyphs}
          sessionIdentity={sessionIdentity}
          opacity={renderPlan.vectors.opacity}
          segments={vectorLayerInput.segments}
          glyphColorsOverride={vectorLayerInput.glyphColors}
          colorScale={vectorLayerInput.colorScale}
          fieldBufferId={requestedFieldBufferId}
          style={vectorStyleFromSettings(renderSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
});

function meshPartPointSelectionRevision(
  selection: Viewport3DMeshPart | NonNullable<
    Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>["surfaceNodeSelection"]
  >,
): string {
  const explicitIndices = meshPartPointSelectionIndices(selection);
  if (explicitIndices?.length) {
    return `indices:${explicitIndices.length}:${explicitIndices[0] ?? "none"}:${explicitIndices[explicitIndices.length - 1] ?? "none"}`;
  }
  const start = meshPartPointSelectionStart(selection) ?? 0;
  const count = meshPartPointSelectionCount(selection) ?? 0;
  return `range:${start}:${count}`;
}

function meshPartPointSelectionIndices(
  selection: Viewport3DMeshPart | NonNullable<
    Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>["surfaceNodeSelection"]
  >,
): ArrayLike<number> | undefined {
  if ("nodeIndices" in selection && selection.nodeIndices) {
    return selection.nodeIndices;
  }
  if ("node_indices" in selection) return selection.node_indices;
  return undefined;
}

function meshPartPointSelectionStart(
  selection: Viewport3DMeshPart | NonNullable<
    Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>["surfaceNodeSelection"]
  >,
): number | undefined {
  if ("nodeStart" in selection) return selection.nodeStart;
  if ("node_start" in selection) return selection.node_start;
  return undefined;
}

function meshPartPointSelectionCount(
  selection: Viewport3DMeshPart | NonNullable<
    Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>["surfaceNodeSelection"]
  >,
): number | undefined {
  if ("nodeCount" in selection) return selection.nodeCount;
  if ("node_count" in selection) return selection.node_count;
  return undefined;
}

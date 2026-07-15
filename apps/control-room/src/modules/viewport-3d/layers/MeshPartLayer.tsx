"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, memo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  type MeshBasicMaterial,
} from "three";
import {
  RENDER_POLICIES,
  materialPolicyProps,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import {
  viewport3DFieldColorLayersEnabledFromBrowserConfig,
  viewport3DVectorLayersEnabledFromBrowserConfig,
} from "@/kernel/browserFullmagConfig";
import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";

import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import {
  resolveMeshPartBounds,
  selectionForMeshPart,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import {
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import { useViewport3DGeometryUpload } from "../hooks/useViewport3DGeometryUpload";
import {
  useViewport3DScalarColorUpload,
  useViewport3DScalarShaderColorUpload,
} from "../hooks/useViewport3DScalarColorUpload";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DMagnetizationTexturePreview } from "../viewport3dPrimitiveModel";
import { createViewport3DIndexedPointGeometry } from "../viewport3dPointGeometry";
import { attachViewport3DSharedTopologyPosition } from "../viewport3dSharedTopologyPositions";
import {
  canApplyScalarShaderColorBuffer,
  createScalarSurfaceShaderMaterial,
  updateScalarSurfaceShaderMaterial,
} from "../viewport3dScalarSurfaceShader";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DNodeSelection,
  Viewport3DTopologyPartRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { BoundsBox } from "./BoundsLayers";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { eventIntersectsRegionOverlay } from "./regionOverlayPicking";
import {
  opacityFromSettings,
  pointColorFromSettings,
  resolveMeshPartSurfaceMaterialColor,
  shaderUsesVertexColors,
  surfaceScalarColorModeFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";
import {
  resolveViewport3DTargetSurfaceLayerInput,
  resolveViewport3DTargetLayerRequestedSourceIdentity,
  resolveViewport3DTargetVectorLayerInput,
} from "./viewport3DLayerPassInputs";
import { VIEWPORT_3D_PICK_PRIORITY } from "./viewport3DPickPriority";
import type {
  Viewport3DRenderAdoptionReceipt,
  Viewport3DRenderAdoptionRegistry,
} from "../model/viewport3DRenderAdoptionRegistry";

const MESH_PART_GEOMETRY_UPLOAD_FRAME_BUDGET_MS = 3;

export function resolveMeshPartScalarColors({
  fieldModel,
  partId,
  scalarColorMode,
  settings,
}: {
  fieldModel: (
    Pick<
      Viewport3DFieldRenderModel,
      "scalarColorsByMode" | "scalarColorsByPartAndMode"
    > &
      Partial<Pick<Viewport3DFieldRenderModel, "targetPasses">>
  ) | null;
  partId: string;
  scalarColorMode: string | null;
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  > &
    Partial<Pick<VisualizationTargetSettings, "surfaceProjectionMode">>;
}): ScalarColorBuffer | null {
  if (!fieldModel || !scalarColorMode) return null;
  const { scalarColors } = resolveViewport3DTargetSurfaceLayerInput({
    fieldModel,
    partId,
    scalarColorMode,
  });
  return scalarColorBufferMatchesSettings(
    scalarColors,
    scalarColorMode,
    settings,
  )
    ? scalarColors
    : null;
}

export function resolveMeshPartVectorLayerInput({
  fieldModel,
  partId,
}: Parameters<typeof resolveViewport3DTargetVectorLayerInput>[0]) {
  return resolveViewport3DTargetVectorLayerInput({ fieldModel, partId });
}

export function createMeshPartSurfaceGeometry({
  expandSurfaceFaces,
  positions,
  surfaceIndices,
}: {
  expandSurfaceFaces: boolean;
  positions: Float32Array;
  surfaceIndices: Uint32Array | null;
}): BufferGeometry | null {
  if (!surfaceIndices?.length) return null;
  const next = new BufferGeometry();
  if (!expandSurfaceFaces) {
    attachViewport3DSharedTopologyPosition(next, positions);
    next.setIndex(new BufferAttribute(surfaceIndices, 1));
    return next;
  }

  const expandedPositions = new Float32Array(surfaceIndices.length * 3);
  for (let index = 0; index < surfaceIndices.length; index += 1) {
    const sourceNode = surfaceIndices[index] ?? -1;
    const sourceOffset = sourceNode * 3;
    const targetOffset = index * 3;
    if (sourceNode < 0 || sourceOffset + 2 >= positions.length) {
      return null;
    }
    expandedPositions[targetOffset] = positions[sourceOffset] ?? 0;
    expandedPositions[targetOffset + 1] = positions[sourceOffset + 1] ?? 0;
    expandedPositions[targetOffset + 2] = positions[sourceOffset + 2] ?? 0;
  }
  next.setAttribute("position", new BufferAttribute(expandedPositions, 3));
  return next;
}

export function resolveMeshPartBoundaryFaceIndexForPick({
  expandedSurfaceFaces,
  faceIndex,
  part,
}: {
  expandedSurfaceFaces: boolean;
  faceIndex: number | null | undefined;
  part: Pick<
    Viewport3DMeshPart,
    "boundary_face_count" | "boundary_face_indices" | "boundary_face_start"
  >;
}): number | null {
  if (faceIndex === null || faceIndex === undefined || faceIndex < 0) {
    return null;
  }
  if (
    !expandedSurfaceFaces &&
    part.boundary_face_count <= 0 &&
    !part.boundary_face_indices?.length
  ) {
    return null;
  }
  const localFaceIndex = Math.floor(faceIndex);
  const explicitFaceIndex = part.boundary_face_indices?.[localFaceIndex];
  if (explicitFaceIndex !== undefined) return explicitFaceIndex;
  if (localFaceIndex >= part.boundary_face_count) return null;
  return part.boundary_face_start + localFaceIndex;
}

export function resolveRetainedMeshPartScalarColors({
  current,
  previous,
  scalarColorMode,
  settings,
  topologyRevision,
  vertexCount,
}: {
  current: ScalarColorBuffer | null;
  previous: ScalarColorBuffer | null;
  scalarColorMode: string | null;
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  > &
    Partial<Pick<VisualizationTargetSettings, "surfaceProjectionMode">>;
  topologyRevision?: number | string | null;
  vertexCount: number;
}): ScalarColorBuffer | null {
  if (current) return current;
  if (!scalarColorMode) return null;
  return scalarColorBufferMatchesRetainedSettings(
    previous,
    scalarColorMode,
    settings,
    topologyRevision,
    vertexCount,
  )
    ? previous
    : null;
}

export function resolveMeshPartVisibleScalarColorState({
  effectiveScalarColors,
  meshQualityColors,
  surfaceVertexCount,
  vertexColorsEnabled,
  visibleScalarColors,
}: {
  effectiveScalarColors: ScalarColorBuffer | null;
  meshQualityColors: ScalarColorBuffer | null;
  surfaceVertexCount: number;
  vertexColorsEnabled: boolean;
  visibleScalarColors: ScalarColorBuffer | null;
}): {
  canUseVertexScalarColors: boolean;
  hasScalarColors: boolean;
} {
  const visibleOrPendingColors = visibleScalarColors ?? effectiveScalarColors;
  const canUseVertexScalarColors =
    Boolean(meshQualityColors) ||
    (vertexColorsEnabled &&
      canApplyVertexScalarColorBuffer(
        visibleOrPendingColors,
        surfaceVertexCount,
      ));
  return {
    canUseVertexScalarColors,
    hasScalarColors: Boolean(canUseVertexScalarColors && visibleScalarColors),
  };
}

function scalarColorBufferMatchesSettings(
  buffer: ScalarColorBuffer | null,
  scalarColorMode: string,
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  > &
    Partial<Pick<VisualizationTargetSettings, "surfaceProjectionMode">>,
): buffer is ScalarColorBuffer {
  if (!buffer) return false;
  if (buffer.colorMode && buffer.colorMode !== scalarColorMode) return false;
  if (
    buffer.colorPalette &&
    settings.scalarColorPalette &&
    buffer.colorPalette !== settings.scalarColorPalette
  ) {
    return false;
  }
  if (
    buffer.quantityId &&
    resolveCanonicalQuantityId(buffer.quantityId) !==
      resolveCanonicalQuantityId(settings.activeQuantityId)
  ) {
    return false;
  }
  if (
    buffer.projectionMode &&
    settings.surfaceProjectionMode &&
    buffer.projectionMode !== settings.surfaceProjectionMode
  ) {
    return false;
  }
  return true;
}

function scalarColorBufferMatchesRetainedSettings(
  buffer: ScalarColorBuffer | null,
  scalarColorMode: string,
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  > &
    Partial<Pick<VisualizationTargetSettings, "surfaceProjectionMode">>,
  topologyRevision: number | string | null | undefined,
  vertexCount: number,
): buffer is ScalarColorBuffer {
  if (!buffer) return false;
  if (
    buffer.topologyRevision &&
    topologyRevision !== undefined &&
    topologyRevision !== null &&
    buffer.topologyRevision !== String(topologyRevision)
  ) {
    return false;
  }
  if (
    buffer.colorPalette &&
    settings.scalarColorPalette &&
    buffer.colorPalette !== settings.scalarColorPalette
  ) {
    return false;
  }
  if (
    buffer.quantityId &&
    resolveCanonicalQuantityId(buffer.quantityId) !==
      resolveCanonicalQuantityId(settings.activeQuantityId)
  ) {
    return false;
  }
  if (
    buffer.projectionMode &&
    settings.surfaceProjectionMode &&
    buffer.projectionMode !== settings.surfaceProjectionMode
  ) {
    return false;
  }
  return (
    canApplyVertexScalarColorBuffer(buffer, vertexCount) ||
    canApplyScalarShaderColorBuffer(buffer, vertexCount)
  );
}

export const MeshPartLayer = memo(function MeshPartLayer({
  adoptionRegistry,
  colors,
  vectorColorMode,
  fieldModel,
  materialProfile,
  onSelectPart,
  partModel,
  magnetizationTexturePreview,
  meshQualityColors,
  settings,
  topologyModel,
  tracker,
  vectorStyle,
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  colors: Viewport3DColors;
  vectorColorMode: string;
  fieldModel: Viewport3DFieldRenderModel | null;
  materialProfile: Viewport3DMaterialProfile;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>;
  magnetizationTexturePreview: Viewport3DMagnetizationTexturePreview | null;
  meshQualityColors: ScalarColorBuffer | null;
  settings: VisualizationTargetSettings;
  topologyModel: Viewport3DTopologyRenderModel | null;
  tracker: Viewport3DResourceTracker;
  vectorStyle: VectorFieldLayerVectorStyle;
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
  const expandSurfaceFaces =
    renderSettings.surfaceProjectionMode !== "raw_nodal" &&
    renderSettings.surfaceColorSource !== "solid";
  const surfaceGeometryProjection = expandSurfaceFaces
    ? renderSettings.surfaceProjectionMode
    : "indexed";
  const surfaceVertexCount = expandSurfaceFaces
    ? surfaceIndices?.length ?? 0
    : topologyModel?.nodeCount ?? 0;
  const topologyNodeCount = topologyModel?.nodeCount ?? 0;
  const createSurfaceGeometry = useCallback(() => {
    if (!topologyModel) return null;
    return createMeshPartSurfaceGeometry({
      expandSurfaceFaces,
      positions: topologyModel.positions,
      surfaceIndices,
    });
  }, [expandSurfaceFaces, surfaceIndices, topologyModel]);
  const geometry = useViewport3DGeometryUpload({
    createGeometry: createSurfaceGeometry,
    dirtyReason: "mesh-part-surface",
    enabled: Boolean(topologyModel && surfaceIndices?.length),
    estimatedBytes:
      (topologyModel?.positions.byteLength ?? 0) +
      (surfaceIndices?.byteLength ?? 0),
    invalidate,
    itemCount: surfaceIndices?.length ?? 0,
    key: `mesh-part-surface:${part.id}:projection=${surfaceGeometryProjection}:topology=${topologyRevision ?? "none"}:positions=${topologyModel?.positions.byteLength ?? 0}:indices=${surfaceIndices?.byteLength ?? 0}`,
    lane: "topology-index",
    targetRevision: topologyRevision === null ? null : String(topologyRevision),
    tracker,
    uploadManager: topologyUploadManager,
  });

  const edgeIndices = resolveMeshPartWireframeEdgeIndices(
    renderSettings.geometryScope,
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
    key: `mesh-part-wireframe:${part.id}:scope=${renderSettings.geometryScope}:topology=${topologyRevision ?? "none"}:positions=${topologyModel?.positions.byteLength ?? 0}:indices=${edgeIndices?.byteLength ?? 0}`,
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
  const scalarColorMode = fieldColorLayersEnabled
    ? surfaceScalarColorModeFromSettings(renderSettings)
    : null;
  const scalarColorRetentionKey = useMemo(() => {
    if (!renderSettings.shaderVisible) return null;
    if (meshQualityColors) {
      return [
        "mesh-quality",
        `part=${part.id}`,
        `topology=${topologyRevision ?? "none"}`,
        `vertices=${topologyNodeCount}`,
      ].join("|");
    }
    if (!fieldColorLayersEnabled || !scalarColorMode) return null;
    return [
      "field",
      `part=${part.id}`,
      `mode=${scalarColorMode}`,
      `quantity=${resolveCanonicalQuantityId(renderSettings.activeQuantityId)}`,
      `palette=${renderSettings.scalarColorPalette ?? "default"}`,
      `projection=${surfaceGeometryProjection}`,
      `topology=${topologyRevision ?? "none"}`,
      `vertices=${surfaceVertexCount}`,
    ].join("|");
  }, [
    fieldColorLayersEnabled,
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
  const effectiveScalarColors = meshQualityColors ?? scalarColors;
  const vertexColorsEnabled =
    Boolean(meshQualityColors) ||
    (fieldColorLayersEnabled && shaderUsesVertexColors(renderSettings));
  const effectiveCanUseVertexScalarColors = canApplyVertexScalarColorBuffer(
    effectiveScalarColors,
    surfaceVertexCount,
  );
  const shaderScalarColorsEnabled =
    !meshQualityColors &&
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
        renderSettings.shaderVisible &&
        (fieldColorLayersEnabled || meshQualityColors),
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
        renderSettings.shaderVisible &&
        (fieldColorLayersEnabled || meshQualityColors) &&
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
  const adoptedScalarColors = visibleShaderScalarColors ?? visibleScalarColors;
  const requestedFieldBufferId = resolveViewport3DTargetLayerRequestedSourceIdentity({
    fieldModel,
    partId: part.id,
  }).fieldBufferId;
  useEffect(() => {
    if (!adoptionRegistry || meshQualityColors || !adoptedScalarColors) return;
    let adoption = recordMeshPartSurfaceAdoption({
      carrierId: part.id,
      fieldBufferId: requestedFieldBufferId,
      registry: adoptionRegistry,
      scalarBuffer: adoptedScalarColors,
    });
    const replay = () => {
      adoption = recordMeshPartSurfaceAdoption({
        carrierId: part.id,
        fieldBufferId: requestedFieldBufferId,
        registry: adoptionRegistry,
        scalarBuffer: adoptedScalarColors,
      });
    };
    const unregister = adoptionRegistry.registerCarrierAdoptionReplay(part.id, replay);
    return () => {
      unregister();
      adoptionRegistry.clearAdoption(adoption);
    };
  }, [
    adoptedScalarColors,
    adoptionRegistry,
    meshQualityColors,
    part.id,
    requestedFieldBufferId,
  ]);

  const materialRef = useRef<MeshBasicMaterial>(null);
  const { hasScalarColors } = resolveMeshPartVisibleScalarColorState({
    effectiveScalarColors,
    meshQualityColors,
    surfaceVertexCount,
    vertexColorsEnabled,
    visibleScalarColors,
  });
  const surfaceOpacity = opacityFromSettings(renderSettings);
  const surfacePolicy = useMemo(
    () => surfaceMaterialPolicyProps(surfaceOpacity),
    [surfaceOpacity],
  );
  const scalarShaderMaterial = useMemo(() => {
    if (!fieldColorLayersEnabled && !meshQualityColors) return null;
    if (!shaderScalarColorsEnabled || !visibleShaderScalarColors) return null;
    return tracker.track(
      "material",
      createScalarSurfaceShaderMaterial(visibleShaderScalarColors, {
        ...surfacePolicy,
        opacity: surfaceOpacity,
        toneMapped: materialProfile.magneticSurface.toneMapped,
      }),
    );
  }, [
    fieldColorLayersEnabled,
    materialProfile.magneticSurface.toneMapped,
    meshQualityColors,
    shaderScalarColorsEnabled,
    surfaceOpacity,
    surfacePolicy,
    tracker,
    visibleShaderScalarColors,
  ]);

  useEffect(
    () => () => tracker.release("material", scalarShaderMaterial),
    [scalarShaderMaterial, tracker],
  );
  useEffect(() => {
    if (!scalarShaderMaterial || !visibleShaderScalarColors) return;
    updateScalarSurfaceShaderMaterial(
      scalarShaderMaterial,
      visibleShaderScalarColors,
      surfaceOpacity,
    );
  }, [scalarShaderMaterial, surfaceOpacity, visibleShaderScalarColors]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.needsUpdate = true;
    }
  }, [hasScalarColors]);

  const vectorLayerInput = resolveMeshPartVectorLayerInput({
    fieldModel,
    partId: part.id,
  });
  const hasAnyVisibleRenderableSubLayer =
    (renderSettings.shaderVisible && Boolean(geometry)) ||
    (renderSettings.wireframeVisible && Boolean(edgeGeometry)) ||
    (renderSettings.pointsVisible && Boolean(pointGeometry)) ||
    renderSettings.boundsVisible ||
    (renderSettings.vectorsVisible &&
      viewport3DVectorLayersEnabledFromBrowserConfig() &&
      Boolean(vectorLayerInput.segments));

  if (!renderSettings.visible || !hasAnyVisibleRenderableSubLayer) return null;
  const meshColor = resolveMeshPartSurfaceMaterialColor(
    renderSettings,
    colors.mesh,
    magnetizationTexturePreview?.color ?? null,
    hasScalarColors,
  );
  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (eventIntersectsRegionOverlay(event)) return;
    event.stopPropagation();
    onSelectPart(
      selectionForMeshPart(
        part,
        resolveMeshPartBoundaryFaceIndexForPick({
          expandedSurfaceFaces: expandSurfaceFaces,
          faceIndex: event.faceIndex,
          part,
        }),
      ),
    );
  };

  return (
    <group
      onPointerDown={handlePointerDown}
      userData={{ viewportSemanticPickPriority: VIEWPORT_3D_PICK_PRIORITY.meshPart }}
    >
      {renderSettings.shaderVisible && geometry ? (
        <mesh
          geometry={geometry}
          renderOrder={surfacePolicy.transparent
            ? RENDER_POLICIES.contextSurface.renderOrder
            : RENDER_POLICIES.solidSurface.renderOrder}
        >
          {scalarShaderMaterial ? (
            <primitive attach="material" object={scalarShaderMaterial} />
          ) : (
            <meshBasicMaterial
              ref={materialRef}
              color={meshColor}
              opacity={surfaceOpacity}
              {...materialProfile.magneticSurface}
              vertexColors={hasScalarColors}
              {...surfacePolicy}
            />
          )}
        </mesh>
      ) : null}
      {renderSettings.wireframeVisible && edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(renderSettings, colors.wire)}
            opacity={wireframeOpacityFromSettings(
              renderSettings,
              materialProfile.featureEdges,
            )}
            {...materialPolicyProps("featureEdges")}
          />
        </lineSegments>
      ) : null}
      {renderSettings.boundsVisible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={Math.max(opacityFromSettings(renderSettings), 0.35)}
        />
      ) : null}
      {renderSettings.pointsVisible && pointGeometry ? (
        <points
          geometry={pointGeometry}
          renderOrder={RENDER_POLICIES.points.renderOrder}
        >
          <pointsMaterial
            color={pointColorFromSettings(renderSettings, colors.wire)}
            opacity={surfaceOpacity}
            sizeAttenuation={false}
            size={3}
            {...materialPolicyProps("points")}
          />
        </points>
      ) : null}
      {viewport3DVectorLayersEnabledFromBrowserConfig() &&
      renderSettings.vectorsVisible ? (
        <VectorFieldLayer
          adoptionRegistry={adoptionRegistry}
          buildReference={vectorLayerInput.buildReference}
          carrierId={part.id}
          colors={colors}
          colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
          materialProfile={materialProfile.glyphs}
          opacity={surfaceOpacity}
          segments={vectorLayerInput.segments}
          fieldBufferId={requestedFieldBufferId}
          style={vectorStyleFromSettings(renderSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
});

export function resolveMeshPartPointNodeSelection(
  geometryScope: "full" | "surface",
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
): Viewport3DNodeSelection {
  return geometryScope === "full"
    ? partModel.fullNodeSelection
    : partModel.surfaceNodeSelection ?? partModel.fullNodeSelection;
}

export function recordMeshPartSurfaceAdoption({
  carrierId,
  fieldBufferId,
  registry,
  scalarBuffer,
}: {
  carrierId: string;
  fieldBufferId: string | null;
  registry: Viewport3DRenderAdoptionRegistry;
  scalarBuffer: ScalarColorBuffer;
}): Omit<Viewport3DRenderAdoptionReceipt, "byteLength" | "targetId"> {
  const adoption = {
    carrierId,
    fieldBufferId: scalarBuffer.sourceFieldBufferId ?? fieldBufferId,
    kind: "surface" as const,
    resourceKey: scalarBuffer.sourceResourceKey ?? null,
    scalarBufferKey:
      scalarBuffer.buildKey ??
      `scalar:${scalarBuffer.quantityId ?? "unknown"}:${scalarBuffer.colorMode ?? "unknown"}:${scalarBuffer.colors.byteLength}`,
    vectorBuildKey: null,
  };
  registry.recordSurfaceAdoption({
    byteLength:
      scalarBuffer.colors.byteLength +
      (scalarBuffer.scalarValues?.byteLength ?? 0),
    ...adoption,
  });
  return adoption;
}

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

export function resolveMeshPartWireframeEdgeIndices(
  geometryScope: VisualizationTargetSettings["geometryScope"],
  partModel: Pick<
    Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
    "edgeIndices" | "volumeEdgeIndices"
  >,
  wireframeVisible = true,
): Uint32Array | null {
  if (!wireframeVisible) return null;
  if (geometryScope === "full") {
    return partModel.volumeEdgeIndices;
  }

  return partModel.edgeIndices;
}

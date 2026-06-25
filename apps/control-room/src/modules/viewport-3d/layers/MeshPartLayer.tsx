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
import {
  canApplyScalarShaderColorBuffer,
  createScalarSurfaceShaderMaterial,
  updateScalarSurfaceShaderMaterial,
} from "../viewport3dScalarSurfaceShader";
import type {
  Viewport3DFieldRenderModel,
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

const MESH_PART_GEOMETRY_UPLOAD_FRAME_BUDGET_MS = 3;

export function resolveMeshPartScalarColors({
  fieldModel,
  partId,
  scalarColorMode,
  settings,
}: {
  fieldModel: Pick<
    Viewport3DFieldRenderModel,
    "scalarColorsByMode" | "scalarColorsByPartAndMode"
  > | null;
  partId: string;
  scalarColorMode: string | null;
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  >;
}): ScalarColorBuffer | null {
  if (!fieldModel || !scalarColorMode) return null;
  const partBuffer =
    fieldModel.scalarColorsByPartAndMode.get(partId)?.get(scalarColorMode) ??
    null;
  if (scalarColorBufferMatchesSettings(partBuffer, scalarColorMode, settings)) {
    return partBuffer;
  }

  const globalBuffer = fieldModel.scalarColorsByMode.get(scalarColorMode) ?? null;
  return scalarColorBufferMatchesSettings(
    globalBuffer,
    scalarColorMode,
    settings,
  )
    ? globalBuffer
    : null;
}

export function resolveRetainedMeshPartScalarColors({
  current,
  previous,
  scalarColorMode,
  settings,
  vertexCount,
}: {
  current: ScalarColorBuffer | null;
  previous: ScalarColorBuffer | null;
  scalarColorMode: string | null;
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  >;
  vertexCount: number;
}): ScalarColorBuffer | null {
  if (current) return current;
  if (!scalarColorMode) return null;
  return scalarColorBufferMatchesRetainedSettings(
    previous,
    scalarColorMode,
    settings,
    vertexCount,
  )
    ? previous
    : null;
}

function scalarColorBufferMatchesSettings(
  buffer: ScalarColorBuffer | null,
  scalarColorMode: string,
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  >,
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
  return true;
}

function scalarColorBufferMatchesRetainedSettings(
  buffer: ScalarColorBuffer | null,
  scalarColorMode: string,
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  >,
  vertexCount: number,
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
  return (
    canApplyVertexScalarColorBuffer(buffer, vertexCount) ||
    canApplyScalarShaderColorBuffer(buffer, vertexCount)
  );
}

export const MeshPartLayer = memo(function MeshPartLayer({
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
  const createSurfaceGeometry = useCallback(() => {
    if (!topologyModel) return null;
    if (!surfaceIndices?.length) return null;

    const next = new BufferGeometry();
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
    next.setIndex(new BufferAttribute(surfaceIndices, 1));
    return next;
  }, [surfaceIndices, topologyModel]);
  const geometry = useViewport3DGeometryUpload({
    createGeometry: createSurfaceGeometry,
    dirtyReason: "mesh-part-surface",
    enabled: Boolean(topologyModel && surfaceIndices?.length),
    estimatedBytes:
      (topologyModel?.positions.byteLength ?? 0) +
      (surfaceIndices?.byteLength ?? 0),
    invalidate,
    itemCount: surfaceIndices?.length ?? 0,
    key: `mesh-part-surface:${part.id}:topology=${topologyRevision ?? "none"}:positions=${topologyModel?.positions.byteLength ?? 0}:indices=${surfaceIndices?.byteLength ?? 0}`,
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
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
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

  const nodeSelection =
    renderSettings.geometryScope === "full"
      ? partModel.part
      : partModel.surfaceNodeSelection ?? partModel.part;
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
    vertexCount: topologyModel?.nodeCount ?? 0,
  });
  useEffect(() => {
    const vertexCount = topologyModel?.nodeCount ?? 0;
    if (
      scalarColorMode &&
      scalarColorBufferMatchesRetainedSettings(
        scalarColorsCandidate,
        scalarColorMode,
        renderSettings,
        vertexCount,
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
    topologyModel?.nodeCount,
  ]);
  const effectiveScalarColors = meshQualityColors ?? scalarColors;
  const vertexColorsEnabled =
    Boolean(meshQualityColors) ||
    (fieldColorLayersEnabled && shaderUsesVertexColors(renderSettings));
  const canUseVertexScalarColors = canApplyVertexScalarColorBuffer(
    effectiveScalarColors,
    topologyModel?.nodeCount ?? 0,
  );
  const shaderScalarColorsEnabled =
    !meshQualityColors &&
    vertexColorsEnabled &&
    canApplyScalarShaderColorBuffer(
      effectiveScalarColors,
      topologyModel?.nodeCount ?? 0,
    ) &&
    !canUseVertexScalarColors;
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
    targetRevision: effectiveScalarColors?.targetRevision ?? null,
    tracker,
    uploadKey:
      effectiveScalarColors?.buildKey ??
      `mesh-part-shader-values:${part.id}:${topologyModel?.nodeCount ?? 0}`,
    vertexCount: topologyModel?.nodeCount ?? 0,
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
    targetRevision: effectiveScalarColors?.targetRevision ?? null,
    tracker,
    uploadKey:
      effectiveScalarColors?.buildKey ??
      `mesh-part-colors:${part.id}:${topologyModel?.nodeCount ?? 0}`,
    vertexColorsEnabled,
    vertexCount: topologyModel?.nodeCount ?? 0,
  });

  const materialRef = useRef<MeshBasicMaterial>(null);
  const hasScalarColors =
    vertexColorsEnabled &&
    canUseVertexScalarColors &&
    visibleScalarColors === effectiveScalarColors;
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

  const hasAnyVisibleSubLayer =
    renderSettings.shaderVisible ||
    renderSettings.wireframeVisible ||
    renderSettings.pointsVisible ||
    renderSettings.vectorsVisible ||
    renderSettings.boundsVisible;

  if (!geometry || !renderSettings.visible || !hasAnyVisibleSubLayer) return null;
  const meshColor = resolveMeshPartSurfaceMaterialColor(
    renderSettings,
    colors.mesh,
    magnetizationTexturePreview?.color ?? null,
    hasScalarColors,
  );
  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (eventIntersectsRegionOverlay(event)) return;
    event.stopPropagation();
    onSelectPart(selectionForMeshPart(part));
  };

  return (
    <group onPointerDown={handlePointerDown}>
      {renderSettings.shaderVisible ? (
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
      {renderSettings.wireframeVisible && renderSettings.shaderVisible && edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.hiddenEdges.renderOrder}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(renderSettings, colors.wire)}
            opacity={wireframeOpacityFromSettings(
              renderSettings,
              materialProfile.featureEdges,
            ) * 0.25}
            {...materialPolicyProps("hiddenEdges")}
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
          buildReference={fieldModel?.partVectorBuilds.get(part.id) ?? null}
          colors={colors}
          colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
          materialProfile={materialProfile.glyphs}
          opacity={surfaceOpacity}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
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

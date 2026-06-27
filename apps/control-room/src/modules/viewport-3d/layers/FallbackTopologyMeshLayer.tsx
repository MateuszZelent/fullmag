"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";
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

import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import {
  resolveFemPartSelectionByBoundaryFace,
  type FemManifestRenderDomain,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import {
  buildLineIndexGeometry,
} from "../viewport3dSurfaceEdges";
import { createViewport3DIndexedPointGeometry } from "../viewport3dPointGeometry";
import {
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import { useViewport3DGeometryUpload } from "../hooks/useViewport3DGeometryUpload";
import {
  useViewport3DScalarColorUpload,
  useViewport3DScalarShaderColorUpload,
} from "../hooks/useViewport3DScalarColorUpload";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import { FULL_VIEWPORT_3D_TARGET_ID } from "../viewport3dRenderModel";
import {
  canApplyScalarShaderColorBuffer,
  createScalarSurfaceShaderMaterial,
  updateScalarSurfaceShaderMaterial,
} from "../viewport3dScalarSurfaceShader";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import { eventIntersectsRegionOverlay } from "./regionOverlayPicking";
import {
  resolveViewport3DTargetSurfaceLayerInput,
  resolveViewport3DTargetVectorLayerInput,
} from "./viewport3DLayerPassInputs";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import {
  opacityFromSettings,
  pointColorFromSettings,
  shaderUsesVertexColors,
  surfaceMaterialColorFromSettings,
  surfaceScalarColorModeFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";

const FALLBACK_TOPOLOGY_GEOMETRY_UPLOAD_FRAME_BUDGET_MS = 3;

export function FallbackTopologyMeshLayer({
  colors,
  vectorColorMode,
  fallbackSettings,
  femDomain,
  fieldModel,
  materialProfile,
  meshQualityColors,
  onSelectDomain,
  onSelectPart,
  topologyModel,
  tracker,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  vectorColorMode: string;
  fallbackSettings: VisualizationTargetSettings;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
  materialProfile: Viewport3DMaterialProfile;
  meshQualityColors: ScalarColorBuffer | null;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  topologyModel: Viewport3DTopologyRenderModel | null;
  tracker: Viewport3DResourceTracker;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const invalidate = useBatchedInvalidate();
  const renderSettings = fallbackSettings;
  const topologyUploadManager = useMemo(
    () =>
      createViewport3DGpuUploadManager({
        policy: {
          targetFrameBudgetMs: FALLBACK_TOPOLOGY_GEOMETRY_UPLOAD_FRAME_BUDGET_MS,
        },
      }),
    [],
  );
  useEffect(() => () => topologyUploadManager.dispose(), [topologyUploadManager]);

  const topologyRevision = topologyModel?.meshRevision ?? null;
  const createSurfaceGeometry = useCallback(() => {
    if (!topologyModel) return null;
    const next = new BufferGeometry();
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
    next.setIndex(new BufferAttribute(topologyModel.fallbackSurfaceIndices, 1));
    return next;
  }, [topologyModel]);
  const geometry = useViewport3DGeometryUpload({
    createGeometry: createSurfaceGeometry,
    dirtyReason: "fallback-topology-surface",
    enabled: Boolean(topologyModel),
    estimatedBytes:
      (topologyModel?.positions.byteLength ?? 0) +
      (topologyModel?.fallbackSurfaceIndices.byteLength ?? 0),
    invalidate,
    itemCount: topologyModel?.fallbackSurfaceIndices.length ?? 0,
    key: `fallback-topology-surface:topology=${topologyRevision ?? "none"}:positions=${topologyModel?.positions.byteLength ?? 0}:indices=${topologyModel?.fallbackSurfaceIndices.byteLength ?? 0}`,
    lane: "topology-index",
    targetRevision: topologyRevision === null ? null : String(topologyRevision),
    tracker,
    uploadManager: topologyUploadManager,
  });

  const edgeIndices =
    renderSettings.geometryScope === "full"
      ? topologyModel?.fallbackVolumeEdgeIndices ?? null
      : topologyModel?.fallbackSurfaceEdgeIndices ?? null;
  const createEdgeGeometry = useCallback(() => {
    if (!topologyModel) return null;
    const next = buildLineIndexGeometry(topologyModel.positions, edgeIndices);
    return next;
  }, [edgeIndices, topologyModel]);
  const edgeGeometry = useViewport3DGeometryUpload({
    createGeometry: createEdgeGeometry,
    dirtyReason: "fallback-topology-wireframe",
    enabled: Boolean(
      renderSettings.wireframeVisible && topologyModel && edgeIndices?.length,
    ),
    estimatedBytes:
      (topologyModel?.positions.byteLength ?? 0) + (edgeIndices?.byteLength ?? 0),
    invalidate,
    itemCount: edgeIndices?.length ?? 0,
    key: `fallback-topology-wireframe:scope=${renderSettings.geometryScope}:topology=${topologyRevision ?? "none"}:positions=${topologyModel?.positions.byteLength ?? 0}:indices=${edgeIndices?.byteLength ?? 0}`,
    lane: "topology-index",
    targetRevision: topologyRevision === null ? null : String(topologyRevision),
    tracker,
    uploadManager: topologyUploadManager,
  });

  const pointSelection = useMemo(
    () =>
      renderSettings.geometryScope === "full"
        ? null
        : { nodeIndices: topologyModel?.fallbackSurfaceNodeIndices },
    [renderSettings.geometryScope, topologyModel?.fallbackSurfaceNodeIndices],
  );
  const createPointGeometry = useCallback(() => {
    if (!renderSettings.pointsVisible) return null;
    if (!topologyModel) return null;
    return createViewport3DIndexedPointGeometry(topologyModel, pointSelection);
  }, [pointSelection, renderSettings.pointsVisible, topologyModel]);
  const pointGeometry = useViewport3DGeometryUpload({
    createGeometry: createPointGeometry,
    dirtyReason: "fallback-topology-points",
    enabled: Boolean(renderSettings.pointsVisible && topologyModel),
    estimatedBytes:
      (topologyModel?.positions.byteLength ?? 0) +
      fallbackPointSelectionEstimatedBytes(pointSelection),
    invalidate,
    itemCount: fallbackPointSelectionCount(pointSelection, topologyModel),
    key: `fallback-topology-points:scope=${renderSettings.geometryScope}:topology=${topologyRevision ?? "none"}:positions=${topologyModel?.positions.byteLength ?? 0}:selection=${fallbackPointSelectionRevision(pointSelection, topologyModel)}`,
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
  const { scalarColors } = resolveViewport3DTargetSurfaceLayerInput({
    fieldModel,
    partId: FULL_VIEWPORT_3D_TARGET_ID,
    scalarColorMode,
  });
  const vectorLayerInput = resolveViewport3DTargetVectorLayerInput({
    fieldModel,
    partId: FULL_VIEWPORT_3D_TARGET_ID,
  });
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
      `fallback-surface-shader-values:${topologyModel?.nodeCount ?? 0}`,
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
      `fallback-surface-colors:${topologyModel?.nodeCount ?? 0}`,
    vertexColorsEnabled,
    vertexCount: topologyModel?.nodeCount ?? 0,
  });

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

  const hasAnyVisibleSubLayer =
    renderSettings.shaderVisible ||
    renderSettings.wireframeVisible ||
    renderSettings.pointsVisible ||
    renderSettings.vectorsVisible ||
    renderSettings.boundsVisible;
  if (
    !renderSettings.visible ||
    !hasAnyVisibleSubLayer
  ) {
    return null;
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (eventIntersectsRegionOverlay(event)) return;
    event.stopPropagation();
    const partSelection = resolveFemPartSelectionByBoundaryFace(
      femDomain,
      event.faceIndex,
    );
    if (partSelection) {
      onSelectPart(partSelection);
      return;
    }

    onSelectDomain();
  };

  return (
    <FallbackTopologyMeshPrimitives
      colors={colors}
      edgeGeometry={edgeGeometry}
      geometry={geometry}
      hasScalarColors={hasScalarColors}
      materialProfile={materialProfile}
      onPointerDown={handlePointerDown}
      pointGeometry={pointGeometry}
      renderSettings={renderSettings}
      scalarShaderMaterial={scalarShaderMaterial}
      surfaceOpacity={surfaceOpacity}
      surfacePolicy={surfacePolicy}
      tracker={tracker}
      vectorBuildReference={vectorLayerInput.buildReference}
      vectorColorMode={vectorColorMode}
      vectorSegments={vectorLayerInput.segments}
      vectorStyle={vectorStyle}
    />
  );
}

function FallbackTopologyMeshPrimitives({
  colors,
  edgeGeometry,
  geometry,
  hasScalarColors,
  materialProfile,
  onPointerDown,
  pointGeometry,
  renderSettings,
  scalarShaderMaterial,
  surfaceOpacity,
  surfacePolicy,
  tracker,
  vectorBuildReference,
  vectorColorMode,
  vectorSegments,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  edgeGeometry: BufferGeometry | null;
  geometry: BufferGeometry | null;
  hasScalarColors: boolean;
  materialProfile: Viewport3DMaterialProfile;
  onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
  pointGeometry: BufferGeometry | null;
  renderSettings: VisualizationTargetSettings;
  scalarShaderMaterial: ReturnType<typeof createScalarSurfaceShaderMaterial> | null;
  surfaceOpacity: number;
  surfacePolicy: ReturnType<typeof surfaceMaterialPolicyProps>;
  tracker: Viewport3DResourceTracker;
  vectorBuildReference: Viewport3DFieldRenderModel["fullVectorBuild"];
  vectorColorMode: string;
  vectorSegments: Viewport3DFieldRenderModel["fullVectorSegments"];
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  return (
    <group onPointerDown={onPointerDown}>
      {renderSettings.shaderVisible && geometry ? (
        <mesh
          geometry={geometry}
          renderOrder={
            surfacePolicy.transparent
              ? RENDER_POLICIES.contextSurface.renderOrder
              : RENDER_POLICIES.solidSurface.renderOrder
          }
        >
          {scalarShaderMaterial ? (
            <primitive attach="material" object={scalarShaderMaterial} />
          ) : (
            <meshBasicMaterial
              color={surfaceMaterialColorFromSettings(
                renderSettings,
                colors.mesh,
                hasScalarColors,
              )}
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
          buildReference={vectorBuildReference}
          colors={colors}
          colorMode={vectorColorModeFromSettings(
            renderSettings,
            vectorColorMode,
          )}
          materialProfile={materialProfile.glyphs}
          opacity={surfaceOpacity}
          segments={vectorSegments}
          style={vectorStyleFromSettings(renderSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

function fallbackPointSelectionEstimatedBytes(
  selection: { nodeIndices: Uint32Array | undefined } | null,
): number {
  return (selection?.nodeIndices?.length ?? 0) * Uint32Array.BYTES_PER_ELEMENT;
}

function fallbackPointSelectionCount(
  selection: { nodeIndices: Uint32Array | undefined } | null,
  topologyModel: Viewport3DTopologyRenderModel | null,
): number {
  return selection?.nodeIndices?.length ?? topologyModel?.nodeCount ?? 0;
}

function fallbackPointSelectionRevision(
  selection: { nodeIndices: Uint32Array | undefined } | null,
  topologyModel: Viewport3DTopologyRenderModel | null,
): string {
  if (!selection) return `full:${topologyModel?.nodeCount ?? 0}`;
  const indices = selection.nodeIndices;
  if (!indices?.length) return "surface:empty";
  return `surface:${indices.length}:${indices[0] ?? "none"}:${indices[indices.length - 1] ?? "none"}`;
}

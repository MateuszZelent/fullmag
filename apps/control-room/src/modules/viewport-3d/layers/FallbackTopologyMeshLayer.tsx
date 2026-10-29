"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import {
  RENDER_POLICIES,
  materialPolicyProps,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
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
import { attachViewport3DSharedTopologyPosition } from "../viewport3dSharedTopologyPositions";
import {
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import { useViewport3DGeometryUpload } from "../hooks/useViewport3DGeometryUpload";
import {
  useViewport3DScalarColorUpload,
  useViewport3DScalarShaderColorUpload,
} from "../hooks/useViewport3DScalarColorUpload";
import { resolveViewport3DScalarColorBufferKey, type ScalarColorBuffer } from "../viewport3dFieldMapping";
import { selectVisibleSurfaceChoice, visibleColorScaleFromBuffer, type Viewport3DVisibleSurfaceChoice, type Viewport3DVisibleColorScale, type Viewport3DVisibleColorScaleReport } from "../model/viewport3DVisibleColorScale";
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
  pointColorFromSettings,
  shaderUsesVertexColors,
  surfaceMaterialColorFromSettings,
  surfaceScalarColorModeFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
} from "./viewport3DLayerSettings";
import {
  resolveViewport3DTargetRenderPlan,
  type Viewport3DTargetRenderPlan,
} from "./viewport3DTargetRenderPlan";

const FALLBACK_TOPOLOGY_GEOMETRY_UPLOAD_FRAME_BUDGET_MS = 3;

export function FallbackTopologyMeshLayer({
  colors,
  colorScopeKey,
  onVisibleColorScale,
  sessionIdentity,
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
  colorScopeKey?: string | null;
  onVisibleColorScale?: (report: Viewport3DVisibleColorScaleReport) => void;
  sessionIdentity?: SessionResourceIdentity | null;
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
    attachViewport3DSharedTopologyPosition(next, topologyModel.positions);
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
  const visibleShaderScalarColorsUpload = useViewport3DScalarShaderColorUpload({
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
    retentionKey: colorScopeKey,
    targetRevision: effectiveScalarColors?.targetRevision ?? null,
    tracker,
    uploadKey:
      effectiveScalarColors?.buildKey ??
      `fallback-surface-shader-values:${topologyModel?.nodeCount ?? 0}`,
    vertexCount: topologyModel?.nodeCount ?? 0,
  });
  const visibleShaderScalarColors = visibleShaderScalarColorsUpload.buffer;
  const visibleScalarColorsUpload = useViewport3DScalarColorUpload({
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
    retentionKey: colorScopeKey,
    targetRevision: effectiveScalarColors?.targetRevision ?? null,
    tracker,
    uploadKey:
      effectiveScalarColors?.buildKey ??
      `fallback-surface-colors:${topologyModel?.nodeCount ?? 0}`,
    vertexColorsEnabled,
    vertexCount: topologyModel?.nodeCount ?? 0,
  });
  const visibleScalarColors = visibleScalarColorsUpload.buffer;

  const [surfaceChoice, setSurfaceChoice] = useState<Viewport3DVisibleSurfaceChoice>({ scopeKey: null, shader: false, bufferKey: null });
  const requestedSurfaceUpload = shaderScalarColorsEnabled ? visibleShaderScalarColorsUpload : visibleScalarColorsUpload;
  const candidateSurfaceBuffer = requestedSurfaceUpload.fresh && requestedSurfaceUpload.buffer === effectiveScalarColors
    ? requestedSurfaceUpload.buffer : null;
  const confirmedChoice = selectVisibleSurfaceChoice(surfaceChoice, { scopeKey: colorScopeKey ?? null,
    enabled: vertexColorsEnabled, shader: shaderScalarColorsEnabled,
    bufferKey: candidateSurfaceBuffer ? resolveViewport3DScalarColorBufferKey(candidateSurfaceBuffer) : null });
  if (confirmedChoice !== surfaceChoice) setSurfaceChoice(confirmedChoice);
  const confirmedSurfaceBuffer = confirmedChoice.shader ? visibleShaderScalarColors : visibleScalarColors;
  const retainedSurfaceBuffer = confirmedSurfaceBuffer && confirmedChoice.bufferKey === resolveViewport3DScalarColorBufferKey(confirmedSurfaceBuffer)
    ? confirmedSurfaceBuffer : null;
  const shaderSurfaceBuffer = !vertexColorsEnabled ? null : colorScopeKey
    ? confirmedChoice.shader ? retainedSurfaceBuffer : null
    : shaderScalarColorsEnabled ? visibleShaderScalarColors : null;
  const vertexSurfaceBuffer = colorScopeKey
    ? !confirmedChoice.shader ? retainedSurfaceBuffer : null
    : visibleScalarColors;
  const hasScalarColors = vertexColorsEnabled && (colorScopeKey
    ? canApplyVertexScalarColorBuffer(vertexSurfaceBuffer, topologyModel?.nodeCount ?? 0)
    : canUseVertexScalarColors && visibleScalarColors === effectiveScalarColors);
  const renderPlan = resolveViewport3DTargetRenderPlan(
    renderSettings,
    materialProfile,
  );
  const surfaceOpacity = renderPlan.surface.opacity;
  const surfacePolicy = useMemo(
    () => surfaceMaterialPolicyProps(surfaceOpacity),
    [surfaceOpacity],
  );
  const scalarShaderMaterial = useMemo(() => {
    if (!fieldColorLayersEnabled && !meshQualityColors) return null;
    if (!shaderSurfaceBuffer) return null;
    return tracker.track(
      "material",
      createScalarSurfaceShaderMaterial(shaderSurfaceBuffer, {
        ...surfacePolicy,
        opacity: surfaceOpacity,
        shadeStrength: 0,
        toneMapped: materialProfile.magneticSurface.toneMapped,
      }),
    );
  }, [
    fieldColorLayersEnabled,
    materialProfile.magneticSurface.toneMapped,
    meshQualityColors,
    shaderSurfaceBuffer,
    surfaceOpacity,
    surfacePolicy,
    tracker,
  ]);

  useEffect(
    () => () => tracker.release("material", scalarShaderMaterial),
    [scalarShaderMaterial, tracker],
  );
  useEffect(() => {
    if (!scalarShaderMaterial || !shaderSurfaceBuffer) return;
    updateScalarSurfaceShaderMaterial(
      scalarShaderMaterial,
      shaderSurfaceBuffer,
      surfaceOpacity,
    );
  }, [scalarShaderMaterial, shaderSurfaceBuffer, surfaceOpacity]);

  const surfaceOwnerId = `saved-surface:${useId()}`;
  const visibleSurfaceBuffer = renderSettings.visible && renderPlan.surface.visible && !meshQualityColors
    ? scalarShaderMaterial ? shaderSurfaceBuffer : hasScalarColors ? vertexSurfaceBuffer : null
    : null;
  const surfaceScale = useMemo(() => visibleColorScaleFromBuffer(visibleSurfaceBuffer), [visibleSurfaceBuffer]);
  useEffect(() => {
    if (colorScopeKey) onVisibleColorScale?.({ scopeKey: colorScopeKey, ownerId: surfaceOwnerId,
      pass: "surface", scale: surfaceScale });
  }, [colorScopeKey, onVisibleColorScale, surfaceOwnerId, surfaceScale]);
  useEffect(() => () => {
    if (colorScopeKey) onVisibleColorScale?.({ scopeKey: colorScopeKey, ownerId: surfaceOwnerId,
      pass: "surface", scale: null, removed: true });
  }, [colorScopeKey, onVisibleColorScale, surfaceOwnerId]);
  const vectorColorBuffer = fieldModel?.scalarColorsByMode.get(vectorColorModeFromSettings(renderSettings, vectorColorMode));
  const vectorColorScale = useMemo(() => visibleColorScaleFromBuffer(vectorColorBuffer), [vectorColorBuffer]);

  const hasAnyVisibleSubLayer =
    renderPlan.surface.visible ||
    renderPlan.wireframe.visible ||
    renderPlan.points.visible ||
    renderPlan.vectors.visible ||
    renderPlan.bounds.visible;
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
      colorScopeKey={colorScopeKey}
      onVisibleColorScale={onVisibleColorScale}
      vectorColorScale={vectorColorScale}
      edgeGeometry={edgeGeometry}
      geometry={geometry}
      hasScalarColors={hasScalarColors}
      materialProfile={materialProfile}
      onPointerDown={handlePointerDown}
      pointGeometry={pointGeometry}
      renderSettings={renderSettings}
      renderPlan={renderPlan}
      sessionIdentity={sessionIdentity}
      scalarShaderMaterial={scalarShaderMaterial}
      surfaceOpacity={surfaceOpacity}
      surfacePolicy={surfacePolicy}
      tracker={tracker}
      vectorBuildReference={vectorLayerInput.buildReference}
      vectorColorMode={vectorColorMode}
      vectorGlyphColors={vectorLayerInput.glyphColors ?? null}
      vectorSegments={vectorLayerInput.segments}
      vectorStyle={vectorStyle}
    />
  );
}

function FallbackTopologyMeshPrimitives({
  colors,
  colorScopeKey,
  onVisibleColorScale,
  vectorColorScale,
  edgeGeometry,
  geometry,
  hasScalarColors,
  materialProfile,
  onPointerDown,
  pointGeometry,
  renderSettings,
  renderPlan,
  sessionIdentity,
  scalarShaderMaterial,
  surfaceOpacity,
  surfacePolicy,
  tracker,
  vectorBuildReference,
  vectorColorMode,
  vectorGlyphColors,
  vectorSegments,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  colorScopeKey?: string | null;
  onVisibleColorScale?: (report: Viewport3DVisibleColorScaleReport) => void;
  vectorColorScale: Viewport3DVisibleColorScale | null;
  edgeGeometry: BufferGeometry | null;
  geometry: BufferGeometry | null;
  hasScalarColors: boolean;
  materialProfile: Viewport3DMaterialProfile;
  onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
  pointGeometry: BufferGeometry | null;
  renderSettings: VisualizationTargetSettings;
  renderPlan: Viewport3DTargetRenderPlan;
  sessionIdentity?: SessionResourceIdentity | null;
  scalarShaderMaterial: ReturnType<typeof createScalarSurfaceShaderMaterial> | null;
  surfaceOpacity: number;
  surfacePolicy: ReturnType<typeof surfaceMaterialPolicyProps>;
  tracker: Viewport3DResourceTracker;
  vectorBuildReference: Viewport3DFieldRenderModel["fullVectorBuild"];
  vectorColorMode: string;
  vectorGlyphColors: Float32Array | null;
  vectorSegments: Viewport3DFieldRenderModel["fullVectorSegments"];
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  return (
    <group onPointerDown={onPointerDown}>
      {renderPlan.surface.visible && geometry ? (
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
              key={hasScalarColors ? "fallback-vertex-colors" : "fallback-solid"}
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
      {renderPlan.wireframe.visible && edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(renderSettings, colors.wire)}
            opacity={renderPlan.wireframe.opacity}
            {...materialPolicyProps("featureEdges")}
          />
        </lineSegments>
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
      renderPlan.vectors.visible ? (
        <VectorFieldLayer
          buildReference={vectorBuildReference}
          glyphColorsOverride={vectorGlyphColors}
          colorScale={vectorColorScale}
          colorScopeKey={colorScopeKey}
          onVisibleColorScale={onVisibleColorScale}
          colors={colors}
          colorMode={vectorColorModeFromSettings(
            renderSettings,
            vectorColorMode,
          )}
          materialProfile={materialProfile.glyphs}
          opacity={renderPlan.vectors.opacity}
          sessionIdentity={sessionIdentity}
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

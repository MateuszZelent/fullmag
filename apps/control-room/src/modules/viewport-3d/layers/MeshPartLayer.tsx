"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, memo, useRef } from "react";
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

import {
  resolveMeshPartBounds,
  selectionForMeshPart,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import {
  applyVertexScalarColorBuffer,
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DMagnetizationTexturePreview } from "../viewport3dPrimitiveModel";
import { buildViewport3DPointGeometry } from "../viewport3dPointGeometry";
import {
  applyScalarShaderColorBuffer,
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
  const geometry = useMemo(() => {
    if (!topologyModel) return null;
    const surfaceIndices = partModel.surfaceIndices;
    if (!surfaceIndices?.length) return null;

    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
    next.setIndex(new BufferAttribute(surfaceIndices, 1));
    return next;
  }, [partModel, topologyModel, tracker]);
  const edgeGeometry = useMemo(() => {
    const edgeIndices = resolveMeshPartWireframeEdgeIndices(
      renderSettings.geometryScope,
      partModel,
      renderSettings.wireframeVisible,
    );
    if (!topologyModel || !edgeIndices) return null;
    const next = new BufferGeometry();
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
    next.setIndex(new BufferAttribute(edgeIndices, 1));
    return tracker.track("geometry", next);
  }, [
    partModel,
    renderSettings.geometryScope,
    renderSettings.wireframeVisible,
    topologyModel,
    tracker,
  ]);

  useEffect(
    () => () => tracker.release("geometry", geometry),
    [geometry, tracker],
  );
  useEffect(
    () => () => tracker.release("geometry", edgeGeometry),
    [edgeGeometry, tracker],
  );
  const pointGeometry = useMemo(() => {
    if (!renderSettings.pointsVisible) return null;
    if (!topologyModel) return null;
    const nodeSelection =
      renderSettings.geometryScope === "full"
        ? partModel.part
        : partModel.surfaceNodeSelection ?? partModel.part;
    const next = buildViewport3DPointGeometry(topologyModel, nodeSelection);
    return next ? tracker.track("geometry", next) : null;
  }, [
    partModel,
    renderSettings.geometryScope,
    renderSettings.pointsVisible,
    topologyModel,
    tracker,
  ]);

  useEffect(
    () => () => tracker.release("geometry", pointGeometry),
    [pointGeometry, tracker],
  );

  const fieldColorLayersEnabled =
    viewport3DFieldColorLayersEnabledFromBrowserConfig();
  const scalarColorMode = fieldColorLayersEnabled
    ? surfaceScalarColorModeFromSettings(renderSettings)
    : null;
  const part = partModel.part;
  const scalarColors = scalarColorMode
    ? fieldModel?.scalarColorsByPartAndMode
        .get(part.id)
        ?.get(scalarColorMode) ??
      fieldModel?.scalarColorsByMode.get(scalarColorMode) ??
      null
    : null;
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
  useEffect(() => {
    if (!geometry || !topologyModel) return;
    if (!fieldColorLayersEnabled && !meshQualityColors) return;
    // Skip the destructive zero-fill when the surface mesh is unmounted
    // (shaderVisible === false).  The geometry's color buffer persists across
    // visibility toggles but the cached ScalarColorBuffer reference is stable,
    // so without this guard the effect would zero the buffer while hidden and
    // then skip re-application on toggle-on (same ref → deps unchanged).
    if (!renderSettings.shaderVisible) return;
    if (shaderScalarColorsEnabled) {
      applyScalarShaderColorBuffer(
        geometry,
        effectiveScalarColors,
        topologyModel.nodeCount,
      );
    } else {
      applyScalarShaderColorBuffer(geometry, null, topologyModel.nodeCount);
      applyVertexScalarColorBuffer(
        geometry,
        vertexColorsEnabled ? effectiveScalarColors : null,
        topologyModel.nodeCount,
      );
    }
    tracker.recordDirtyFrame(
      shaderScalarColorsEnabled
        ? "field-scalar-shader"
        : meshQualityColors
          ? "mesh-quality-colors"
          : "field-colors",
    );
    invalidate();
  }, [
    effectiveScalarColors,
    geometry,
    invalidate,
    fieldColorLayersEnabled,
    meshQualityColors,
    renderSettings.shaderVisible,
    shaderScalarColorsEnabled,
    topologyModel,
    tracker,
    vertexColorsEnabled,
  ]);

  const materialRef = useRef<MeshBasicMaterial>(null);
  const hasScalarColors = vertexColorsEnabled && canUseVertexScalarColors;
  const surfaceOpacity = opacityFromSettings(renderSettings);
  const surfacePolicy = useMemo(
    () => surfaceMaterialPolicyProps(surfaceOpacity),
    [surfaceOpacity],
  );
  const scalarShaderMaterial = useMemo(() => {
    if (!fieldColorLayersEnabled && !meshQualityColors) return null;
    if (!shaderScalarColorsEnabled || !effectiveScalarColors) return null;
    return tracker.track(
      "material",
      createScalarSurfaceShaderMaterial(effectiveScalarColors, {
        ...surfacePolicy,
        opacity: surfaceOpacity,
        toneMapped: materialProfile.magneticSurface.toneMapped,
      }),
    );
  }, [
    effectiveScalarColors,
    fieldColorLayersEnabled,
    materialProfile.magneticSurface.toneMapped,
    meshQualityColors,
    shaderScalarColorsEnabled,
    surfaceOpacity,
    surfacePolicy,
    tracker,
  ]);

  useEffect(
    () => () => tracker.release("material", scalarShaderMaterial),
    [scalarShaderMaterial, tracker],
  );
  useEffect(() => {
    if (!scalarShaderMaterial || !effectiveScalarColors) return;
    updateScalarSurfaceShaderMaterial(
      scalarShaderMaterial,
      effectiveScalarColors,
      surfaceOpacity,
    );
  }, [effectiveScalarColors, scalarShaderMaterial, surfaceOpacity]);

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

"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, memo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  type MeshStandardMaterial,
} from "three";
import {
  RENDER_POLICIES,
  materialPolicyProps,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

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
import {
  opacityFromSettings,
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
    next.computeVertexNormals();
    return next;
  }, [partModel, topologyModel, tracker]);
  const edgeGeometry = useMemo(() => {
    const edgeIndices = resolveMeshPartWireframeEdgeIndices(
      settings.geometryScope,
      partModel,
    );
    if (!topologyModel || !edgeIndices) return null;
    const next = new BufferGeometry();
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
    next.setIndex(new BufferAttribute(edgeIndices, 1));
    return tracker.track("geometry", next);
  }, [partModel, settings.geometryScope, topologyModel, tracker]);

  useEffect(
    () => () => tracker.release("geometry", geometry),
    [geometry, tracker],
  );
  useEffect(
    () => () => tracker.release("geometry", edgeGeometry),
    [edgeGeometry, tracker],
  );
  const pointGeometry = useMemo(() => {
    if (!topologyModel) return null;
    const nodeSelection =
      settings.geometryScope === "full"
        ? partModel.part
        : partModel.surfaceNodeSelection ?? partModel.part;
    const next = buildViewport3DPointGeometry(topologyModel, nodeSelection);
    return next ? tracker.track("geometry", next) : null;
  }, [partModel, settings.geometryScope, topologyModel, tracker]);

  useEffect(
    () => () => tracker.release("geometry", pointGeometry),
    [pointGeometry, tracker],
  );

  const scalarColorMode = surfaceScalarColorModeFromSettings(settings);
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
    Boolean(meshQualityColors) || shaderUsesVertexColors(settings);
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
    // Skip the destructive zero-fill when the surface mesh is unmounted
    // (shaderVisible === false).  The geometry's color buffer persists across
    // visibility toggles but the cached ScalarColorBuffer reference is stable,
    // so without this guard the effect would zero the buffer while hidden and
    // then skip re-application on toggle-on (same ref → deps unchanged).
    if (!settings.shaderVisible) return;
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
    meshQualityColors,
    settings.shaderVisible,
    shaderScalarColorsEnabled,
    topologyModel,
    tracker,
    vertexColorsEnabled,
  ]);

  const materialRef = useRef<MeshStandardMaterial>(null);
  const hasScalarColors = vertexColorsEnabled && canUseVertexScalarColors;
  const surfaceOpacity = opacityFromSettings(settings);
  const surfacePolicy = useMemo(
    () => surfaceMaterialPolicyProps(surfaceOpacity),
    [surfaceOpacity],
  );
  const scalarShaderMaterial = useMemo(() => {
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
    materialProfile.magneticSurface.toneMapped,
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
    settings.shaderVisible ||
    settings.wireframeVisible ||
    settings.pointsVisible ||
    settings.vectorsVisible ||
    settings.boundsVisible;

  if (!geometry || (!settings.visible && !hasAnyVisibleSubLayer)) return null;
  const meshColor = resolveMeshPartSurfaceMaterialColor(
    settings,
    colors.mesh,
    magnetizationTexturePreview?.color ?? null,
    hasScalarColors,
  );
  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectPart(selectionForMeshPart(part));
  };

  return (
    <group onPointerDown={handlePointerDown}>
      {settings.shaderVisible ? (
        <mesh
          geometry={geometry}
          renderOrder={surfacePolicy.transparent
            ? RENDER_POLICIES.contextSurface.renderOrder
            : RENDER_POLICIES.solidSurface.renderOrder}
        >
          {scalarShaderMaterial ? (
            <primitive attach="material" object={scalarShaderMaterial} />
          ) : (
            <meshStandardMaterial
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
      {settings.wireframeVisible && edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(settings, colors.wire)}
            opacity={wireframeOpacityFromSettings(
              settings,
              materialProfile.featureEdges,
            )}
            {...materialPolicyProps("featureEdges")}
          />
        </lineSegments>
      ) : null}
      {settings.wireframeVisible && settings.shaderVisible && settings.geometryScope !== "full" && edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.hiddenEdges.renderOrder}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(settings, colors.wire)}
            opacity={wireframeOpacityFromSettings(
              settings,
              materialProfile.featureEdges,
            ) * 0.25}
            {...materialPolicyProps("hiddenEdges")}
          />
        </lineSegments>
      ) : null}
      {settings.boundsVisible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={Math.max(opacityFromSettings(settings), 0.35)}
        />
      ) : null}
      {settings.pointsVisible && pointGeometry ? (
        <points
          geometry={pointGeometry}
          renderOrder={RENDER_POLICIES.points.renderOrder}
        >
          <pointsMaterial
            color={colors.wire}
            opacity={surfaceOpacity}
            sizeAttenuation={false}
            size={3}
            {...materialPolicyProps("points")}
          />
        </points>
      ) : null}
      {settings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          colorMode={vectorColorModeFromSettings(settings, vectorColorMode)}
          materialProfile={materialProfile.glyphs}
          opacity={surfaceOpacity}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
          style={vectorStyleFromSettings(settings, vectorStyle)}
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
): Uint32Array | null {
  if (geometryScope === "full") {
    return partModel.volumeEdgeIndices;
  }

  return partModel.edgeIndices;
}

"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";
import {
  RENDER_POLICIES,
  materialPolicyProps,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveFemPartSelectionByBoundaryFace,
  type FemManifestRenderDomain,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import {
  buildLineIndexGeometry,
  buildSurfaceEdgeGeometry,
} from "../viewport3dSurfaceEdges";
import { buildViewport3DPointGeometry } from "../viewport3dPointGeometry";
import {
  applyVertexScalarColorBuffer,
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import {
  applyScalarShaderColorBuffer,
  canApplyScalarShaderColorBuffer,
  createScalarSurfaceShaderMaterial,
  updateScalarSurfaceShaderMaterial,
} from "../viewport3dScalarSurfaceShader";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import {
  opacityFromSettings,
  pointColorFromSettings,
  resolveCameraInteractionSettings,
  shaderUsesVertexColors,
  surfaceMaterialColorFromSettings,
  surfaceScalarColorModeFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";

export function FallbackTopologyMeshLayer({
  colors,
  vectorColorMode,
  fallbackSettings,
  femDomain,
  fieldModel,
  interactionActive,
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
  interactionActive: boolean;
  materialProfile: Viewport3DMaterialProfile;
  meshQualityColors: ScalarColorBuffer | null;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  topologyModel: Viewport3DTopologyRenderModel | null;
  tracker: Viewport3DResourceTracker;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const invalidate = useBatchedInvalidate();
  const renderSettings = useMemo(
    () => resolveCameraInteractionSettings(fallbackSettings, interactionActive),
    [fallbackSettings, interactionActive],
  );
  const geometry = useMemo(() => {
    if (!topologyModel) return null;
    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
    next.setIndex(new BufferAttribute(topologyModel.fallbackSurfaceIndices, 1));
    next.computeVertexNormals();
    return next;
  }, [topologyModel, tracker]);
  const edgeGeometry = useMemo(() => {
    if (!topologyModel) return null;
    const next =
      renderSettings.geometryScope === "full"
        ? buildLineIndexGeometry(
            topologyModel.positions,
            topologyModel.fallbackVolumeEdgeIndices,
          )
        : buildSurfaceEdgeGeometry(
            topologyModel.positions,
            topologyModel.fallbackSurfaceIndices,
          );
    return next ? tracker.track("geometry", next) : null;
  }, [renderSettings.geometryScope, topologyModel, tracker]);

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
    const selection =
      renderSettings.geometryScope === "full"
        ? null
        : { nodeIndices: uniqueSortedSurfaceIndices(topologyModel.fallbackSurfaceIndices) };
    const next = buildViewport3DPointGeometry(topologyModel, selection);
    return next ? tracker.track("geometry", next) : null;
  }, [renderSettings.geometryScope, topologyModel, tracker]);

  useEffect(
    () => () => tracker.release("geometry", pointGeometry),
    [pointGeometry, tracker],
  );

  const scalarColorMode = surfaceScalarColorModeFromSettings(renderSettings);
  const scalarColors = scalarColorMode
    ? fieldModel?.scalarColorsByMode.get(scalarColorMode) ?? null
    : null;
  const effectiveScalarColors = meshQualityColors ?? scalarColors;
  const vertexColorsEnabled =
    Boolean(meshQualityColors) || shaderUsesVertexColors(renderSettings);
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
    shaderScalarColorsEnabled,
    topologyModel,
    tracker,
    vertexColorsEnabled,
  ]);

  const hasScalarColors =
    vertexColorsEnabled && canUseVertexScalarColors;
  const surfaceOpacity = opacityFromSettings(renderSettings);
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

  if (!geometry) return null;
  if (
    !renderSettings.visible ||
    (!renderSettings.shaderVisible &&
      !renderSettings.wireframeVisible &&
      !renderSettings.pointsVisible)
  ) {
    return null;
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
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
            <meshStandardMaterial
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
      {renderSettings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          colorMode={vectorColorModeFromSettings(
            renderSettings,
            vectorColorMode,
          )}
          materialProfile={materialProfile.glyphs}
          opacity={surfaceOpacity}
          segments={fieldModel?.fullVectorSegments ?? null}
          style={vectorStyleFromSettings(renderSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

function uniqueSortedSurfaceIndices(indices: Uint32Array): number[] {
  return [...new Set(indices)].toSorted((left, right) => left - right);
}

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
import {
  applyVertexScalarColorBuffer,
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import type { Viewport3DFieldRenderModel, Viewport3DTopologyRenderModel } from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import {
  opacityFromSettings,
  shaderColorFromSettings,
  shaderUsesVertexColors,
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
  materialProfile,
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
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  topologyModel: Viewport3DTopologyRenderModel | null;
  tracker: Viewport3DResourceTracker;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const invalidate = useBatchedInvalidate();
  const geometry = useMemo(() => {
    if (!topologyModel) return null;
    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute(
      "position",
      new BufferAttribute(topologyModel.positions, 3),
    );
    next.setIndex(
      new BufferAttribute(topologyModel.fallbackSurfaceIndices, 1),
    );
    next.computeVertexNormals();
    return next;
  }, [topologyModel, tracker]);
  const edgeGeometry = useMemo(() => {
    if (!topologyModel) return null;
    const next = fallbackSettings.geometryScope === "full"
      ? buildLineIndexGeometry(
          topologyModel.positions,
          topologyModel.fallbackVolumeEdgeIndices,
        )
      : buildSurfaceEdgeGeometry(
          topologyModel.positions,
          topologyModel.fallbackSurfaceIndices,
        );
    return next ? tracker.track("geometry", next) : null;
  }, [fallbackSettings.geometryScope, topologyModel, tracker]);

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);
  useEffect(
    () => () => tracker.release("geometry", edgeGeometry),
    [edgeGeometry, tracker],
  );

  const scalarColorMode = surfaceScalarColorModeFromSettings(fallbackSettings);
  const scalarColors = scalarColorMode
    ? fieldModel?.scalarColorsByMode.get(scalarColorMode) ?? null
    : null;
  useEffect(() => {
    if (!geometry || !topologyModel) return;
    applyVertexScalarColorBuffer(
      geometry,
      shaderUsesVertexColors(fallbackSettings) ? scalarColors : null,
      topologyModel.nodeCount,
    );
    tracker.recordDirtyFrame("field-colors");
    invalidate();
  }, [fallbackSettings, geometry, invalidate, scalarColors, topologyModel, tracker]);

  if (!geometry) return null;
  if (
    !fallbackSettings.visible ||
    (!fallbackSettings.shaderVisible &&
      !fallbackSettings.wireframeVisible &&
      !fallbackSettings.pointsVisible)
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
      {fallbackSettings.shaderVisible ? (
        <mesh
          geometry={geometry}
          renderOrder={surfaceMaterialPolicyProps(opacityFromSettings(fallbackSettings)).transparent
            ? RENDER_POLICIES.contextSurface.renderOrder
            : RENDER_POLICIES.solidSurface.renderOrder}
        >
          <meshStandardMaterial
            color={shaderColorFromSettings(fallbackSettings, colors.mesh)}
            opacity={opacityFromSettings(fallbackSettings)}
            {...materialProfile.magneticSurface}
            vertexColors={
              shaderUsesVertexColors(fallbackSettings) &&
              canApplyVertexScalarColorBuffer(
                scalarColors,
                topologyModel?.nodeCount ?? 0,
              )
            }
            {...surfaceMaterialPolicyProps(opacityFromSettings(fallbackSettings))}
          />
        </mesh>
      ) : null}
      {fallbackSettings.wireframeVisible && edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(fallbackSettings, colors.wire)}
            opacity={wireframeOpacityFromSettings(
              fallbackSettings,
              materialProfile.featureEdges,
            )}
            {...materialPolicyProps("featureEdges")}
          />
        </lineSegments>
      ) : null}
      {fallbackSettings.pointsVisible ? (
        <points
          geometry={geometry}
          renderOrder={RENDER_POLICIES.points.renderOrder}
        >
          <pointsMaterial
            color={colors.wire}
            opacity={opacityFromSettings(fallbackSettings)}
            sizeAttenuation={false}
            size={3}
            {...materialPolicyProps("points")}
          />
        </points>
      ) : null}
      {fallbackSettings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          colorMode={vectorColorModeFromSettings(
            fallbackSettings,
            vectorColorMode,
          )}
          materialProfile={materialProfile.glyphs}
          opacity={opacityFromSettings(fallbackSettings)}
          segments={fieldModel?.fullVectorSegments ?? null}
          style={vectorStyleFromSettings(fallbackSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

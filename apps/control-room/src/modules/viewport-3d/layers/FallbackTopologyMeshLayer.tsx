"use client";

import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveFemPartSelectionByBoundaryFace,
  type FemManifestRenderDomain,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import {
  applyVertexScalarColorBuffer,
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import type { Viewport3DFieldRenderModel, Viewport3DTopologyRenderModel } from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VectorFieldLayer } from "./VectorFieldLayer";
import { opacityFromSettings } from "./viewport3DLayerSettings";

export function FallbackTopologyMeshLayer({
  colors,
  fallbackSettings,
  femDomain,
  fieldModel,
  onSelectDomain,
  onSelectPart,
  topologyModel,
  tracker,
}: {
  colors: Viewport3DColors;
  fallbackSettings: VisualizationTargetSettings;
  femDomain: FemManifestRenderDomain;
  fieldModel: Viewport3DFieldRenderModel | null;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  topologyModel: Viewport3DTopologyRenderModel | null;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useThree((state) => state.invalidate);
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

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);

  useEffect(() => {
    if (!geometry || !topologyModel) return;
    applyVertexScalarColorBuffer(
      geometry,
      fieldModel?.scalarColors,
      topologyModel.nodeCount,
    );
    invalidate();
  }, [fieldModel?.scalarColors, geometry, invalidate, topologyModel]);

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
        <mesh geometry={geometry}>
          <meshStandardMaterial
            color={colors.mesh}
            opacity={opacityFromSettings(fallbackSettings)}
            roughness={0.86}
            transparent
            vertexColors={canApplyVertexScalarColorBuffer(
              fieldModel?.scalarColors,
              topologyModel?.nodeCount ?? 0,
            )}
          />
        </mesh>
      ) : null}
      {fallbackSettings.wireframeVisible ? (
        <mesh geometry={geometry}>
          <meshBasicMaterial
            color={colors.wire}
            opacity={opacityFromSettings(fallbackSettings)}
            transparent
            wireframe
          />
        </mesh>
      ) : null}
      {fallbackSettings.pointsVisible ? (
        <points geometry={geometry}>
          <pointsMaterial
            color={colors.wire}
            opacity={opacityFromSettings(fallbackSettings)}
            size={0.01}
            transparent
          />
        </points>
      ) : null}
      {fallbackSettings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          opacity={opacityFromSettings(fallbackSettings)}
          segments={fieldModel?.fullVectorSegments ?? null}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

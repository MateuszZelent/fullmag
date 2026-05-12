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
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";
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
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  topologyModel: Viewport3DTopologyRenderModel | null;
  tracker: Viewport3DResourceTracker;
  vectorStyle: VectorFieldLayerVectorStyle;
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

  const scalarColorMode = surfaceScalarColorModeFromSettings(fallbackSettings);
  const scalarColors = scalarColorMode
    ? fieldModel?.scalarColorsByMode.get(scalarColorMode) ?? null
    : null;
  useEffect(() => {
    if (!geometry || !topologyModel) return;
    if (!shaderUsesVertexColors(fallbackSettings)) {
      if (geometry.hasAttribute("color")) {
        geometry.deleteAttribute("color");
      }
      tracker.recordDirtyFrame("field-colors");
      invalidate();
      return;
    }
    applyVertexScalarColorBuffer(
      geometry,
      scalarColors,
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
        <mesh geometry={geometry}>
          <meshStandardMaterial
            color={shaderColorFromSettings(fallbackSettings, colors.mesh)}
            opacity={opacityFromSettings(fallbackSettings)}
            roughness={0.86}
            transparent
            vertexColors={
              shaderUsesVertexColors(fallbackSettings) &&
              canApplyVertexScalarColorBuffer(
                scalarColors,
                topologyModel?.nodeCount ?? 0,
              )
            }
          />
        </mesh>
      ) : null}
      {fallbackSettings.wireframeVisible ? (
        <mesh geometry={geometry}>
          <meshBasicMaterial
            color={wireframeColorFromSettings(fallbackSettings, colors.wire)}
            opacity={wireframeOpacityFromSettings(fallbackSettings)}
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
            sizeAttenuation={false}
            size={3}
            transparent
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
          opacity={opacityFromSettings(fallbackSettings)}
          segments={fieldModel?.fullVectorSegments ?? null}
          style={vectorStyleFromSettings(fallbackSettings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

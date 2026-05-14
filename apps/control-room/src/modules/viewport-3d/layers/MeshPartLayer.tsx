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
import type { Viewport3DMagnetizationTexturePreview } from "../viewport3dPrimitiveModel";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyPartRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { BoundsBox } from "./BoundsLayers";
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

export function MeshPartLayer({
  colors,
  vectorColorMode,
  fieldModel,
  onSelectPart,
  partModel,
  magnetizationTexturePreview,
  settings,
  topologyModel,
  tracker,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  vectorColorMode: string;
  fieldModel: Viewport3DFieldRenderModel | null;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>;
  magnetizationTexturePreview: Viewport3DMagnetizationTexturePreview | null;
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

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);

  const scalarColorMode = surfaceScalarColorModeFromSettings(settings);
  const scalarColors = scalarColorMode
    ? fieldModel?.scalarColorsByMode.get(scalarColorMode) ?? null
    : null;
  useEffect(() => {
    if (!geometry || !topologyModel) return;
    applyVertexScalarColorBuffer(
      geometry,
      shaderUsesVertexColors(settings) ? scalarColors : null,
      topologyModel.nodeCount,
    );
    tracker.recordDirtyFrame("field-colors");
    invalidate();
  }, [geometry, invalidate, scalarColors, settings, topologyModel, tracker]);

  if (!geometry || !settings.visible) return null;

  const part = partModel.part;
  const hasScalarColors =
    shaderUsesVertexColors(settings) &&
    canApplyVertexScalarColorBuffer(
      scalarColors,
      topologyModel?.nodeCount ?? 0,
    );
  const meshColor = shaderColorFromSettings(
    settings,
    hasScalarColors
      ? colors.mesh
      : (settings.surfaceColorSource !== "solid"
          ? magnetizationTexturePreview?.color
          : null) ?? colors.mesh,
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
          renderOrder={surfaceMaterialPolicyProps(opacityFromSettings(settings)).transparent
            ? RENDER_POLICIES.contextSurface.renderOrder
            : RENDER_POLICIES.solidSurface.renderOrder}
        >
          <meshStandardMaterial
            color={meshColor}
            opacity={opacityFromSettings(settings)}
            roughness={0.86}
            vertexColors={hasScalarColors}
            {...surfaceMaterialPolicyProps(opacityFromSettings(settings))}
          />
        </mesh>
      ) : null}
      {settings.wireframeVisible ? (
        <mesh
          geometry={geometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
        >
          <meshBasicMaterial
            color={wireframeColorFromSettings(settings, colors.wire)}
            opacity={wireframeOpacityFromSettings(settings)}
            wireframe
            {...materialPolicyProps("featureEdges")}
          />
        </mesh>
      ) : null}
      {settings.boundsVisible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={Math.max(opacityFromSettings(settings), 0.35)}
        />
      ) : null}
      {settings.pointsVisible ? (
        <points
          geometry={geometry}
          renderOrder={RENDER_POLICIES.points.renderOrder}
        >
          <pointsMaterial
            color={colors.wire}
            opacity={opacityFromSettings(settings)}
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
          opacity={opacityFromSettings(settings)}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
          style={vectorStyleFromSettings(settings, vectorStyle)}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

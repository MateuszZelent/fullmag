"use client";

import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveMeshPartBounds,
  selectionForMeshPart,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
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
import { opacityFromSettings } from "./viewport3DLayerSettings";

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
  const invalidate = useThree((state) => state.invalidate);
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

  useEffect(() => {
    if (!geometry || !topologyModel) return;
    applyVertexScalarColorBuffer(
      geometry,
      fieldModel?.scalarColors,
      topologyModel.nodeCount,
    );
    tracker.recordDirtyFrame("field-colors");
    invalidate();
  }, [fieldModel?.scalarColors, geometry, invalidate, topologyModel, tracker]);

  if (!geometry || !settings.visible) return null;

  const part = partModel.part;
  const hasScalarColors = canApplyVertexScalarColorBuffer(
    fieldModel?.scalarColors,
    topologyModel?.nodeCount ?? 0,
  );
  const meshColor = hasScalarColors
    ? colors.mesh
    : (magnetizationTexturePreview?.color ?? colors.mesh);
  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectPart(selectionForMeshPart(part));
  };

  return (
    <group onPointerDown={handlePointerDown}>
      {settings.shaderVisible ? (
        <mesh geometry={geometry}>
          <meshStandardMaterial
            color={meshColor}
            opacity={opacityFromSettings(settings)}
            roughness={0.86}
            transparent
            vertexColors={hasScalarColors}
          />
        </mesh>
      ) : null}
      {settings.wireframeVisible ? (
        <mesh geometry={geometry}>
          <meshBasicMaterial
            color={colors.wire}
            opacity={opacityFromSettings(settings)}
            transparent
            wireframe
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
        <points geometry={geometry}>
          <pointsMaterial
            color={colors.wire}
            opacity={opacityFromSettings(settings)}
            sizeAttenuation={false}
            size={3}
            transparent
          />
        </points>
      ) : null}
      {settings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          colorMode={vectorColorMode}
          opacity={opacityFromSettings(settings)}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
          style={vectorStyle}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

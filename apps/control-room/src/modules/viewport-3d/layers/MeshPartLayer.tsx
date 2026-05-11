"use client";

import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import {
  applyVertexScalarColorBuffer,
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTopologyPartRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VectorFieldLayer } from "./VectorFieldLayer";
import { opacityFromSettings } from "./viewport3DLayerSettings";

export function MeshPartLayer({
  colors,
  fieldModel,
  onSelectPart,
  partModel,
  settings,
  topologyModel,
  tracker,
}: {
  colors: Viewport3DColors;
  fieldModel: Viewport3DFieldRenderModel | null;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>;
  settings: VisualizationTargetSettings;
  topologyModel: Viewport3DTopologyRenderModel | null;
  tracker: Viewport3DResourceTracker;
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
    invalidate();
  }, [fieldModel?.scalarColors, geometry, invalidate, topologyModel]);

  if (!geometry || !settings.visible) return null;

  const part = partModel.part;
  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectPart({
      kind: "mesh-part",
      label: part.label,
      nodeId: part.id,
      objectId: part.object_id ?? null,
      part,
    });
  };

  return (
    <group onPointerDown={handlePointerDown}>
      {settings.shaderVisible ? (
        <mesh geometry={geometry}>
          <meshStandardMaterial
            color={colors.mesh}
            opacity={opacityFromSettings(settings)}
            roughness={0.86}
            transparent
            vertexColors={canApplyVertexScalarColorBuffer(
              fieldModel?.scalarColors,
              topologyModel?.nodeCount ?? 0,
            )}
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
      {settings.pointsVisible ? (
        <points geometry={geometry}>
          <pointsMaterial
            color={colors.wire}
            opacity={opacityFromSettings(settings)}
            size={0.01}
            transparent
          />
        </points>
      ) : null}
      {settings.vectorsVisible ? (
        <VectorFieldLayer
          colors={colors}
          opacity={opacityFromSettings(settings)}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

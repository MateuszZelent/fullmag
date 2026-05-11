"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type {
  DecodedFieldVector,
  DecodedTopology,
} from "@/kernel/api/codecs";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveFemPartSelectionByBoundaryFace,
  resolveMeshPartNodeSelection,
  type FemManifestRenderDomain,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { buildVertexScalarColors } from "../viewport3dFieldMapping";
import {
  buildPartSurfaceIndices,
  buildTetraSurfaceIndices,
  buildTopologyPositions,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VectorFieldLayer } from "./VectorFieldLayer";

function opacityFromSettings(settings: VisualizationTargetSettings): number {
  return Math.max(0, Math.min(1, settings.opacityPercent / 100));
}

export function TopologyMeshLayer({
  colors,
  fallbackSettings,
  fieldVector,
  femDomain,
  getPartSettings,
  onSelectDomain,
  onSelectPart,
  tracker,
  topology,
  vectorScale,
}: {
  colors: Viewport3DColors;
  fallbackSettings: VisualizationTargetSettings;
  fieldVector: DecodedFieldVector | null;
  femDomain: FemManifestRenderDomain;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  tracker: Viewport3DResourceTracker;
  topology: DecodedTopology | null;
  vectorScale: number;
}) {
  if (femDomain.magneticParts.length > 0) {
    return (
      <>
        {femDomain.magneticParts.map((part) => (
          <MeshPartLayer
            colors={colors}
            fieldVector={fieldVector}
            key={part.id}
            onSelectPart={onSelectPart}
            part={part}
            settings={getPartSettings(part)}
            topology={topology}
            tracker={tracker}
            vectorScale={vectorScale}
          />
        ))}
      </>
    );
  }

  return (
    <FallbackTopologyMeshLayer
      colors={colors}
      fallbackSettings={fallbackSettings}
      femDomain={femDomain}
      fieldVector={fieldVector}
      onSelectDomain={onSelectDomain}
      onSelectPart={onSelectPart}
      topology={topology}
      tracker={tracker}
      vectorScale={vectorScale}
    />
  );
}

function FallbackTopologyMeshLayer({
  colors,
  fallbackSettings,
  fieldVector,
  femDomain,
  onSelectDomain,
  onSelectPart,
  topology,
  tracker,
  vectorScale,
}: {
  colors: Viewport3DColors;
  fallbackSettings: VisualizationTargetSettings;
  fieldVector: DecodedFieldVector | null;
  femDomain: FemManifestRenderDomain;
  onSelectDomain: () => void;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  topology: DecodedTopology | null;
  tracker: Viewport3DResourceTracker;
  vectorScale: number;
}) {
  const geometry = useMemo(() => {
    if (!topology) return null;
    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute(
      "position",
      new BufferAttribute(buildTopologyPositions(topology), 3),
    );
    const colorBuffer = buildVertexScalarColors(fieldVector, topology.nodeCount);
    if (colorBuffer) {
      next.setAttribute("color", new BufferAttribute(colorBuffer.colors, 3));
    }
    next.setIndex(new BufferAttribute(buildTetraSurfaceIndices(topology.indices), 1));
    next.computeVertexNormals();
    return next;
  }, [fieldVector, topology, tracker]);

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);

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
            vertexColors={geometry.hasAttribute("color")}
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
          fieldVector={fieldVector}
          opacity={opacityFromSettings(fallbackSettings)}
          scale={vectorScale}
          topology={topology}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

function MeshPartLayer({
  colors,
  fieldVector,
  onSelectPart,
  part,
  settings,
  topology,
  tracker,
  vectorScale,
}: {
  colors: Viewport3DColors;
  fieldVector: DecodedFieldVector | null;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  part: Viewport3DMeshPart;
  settings: VisualizationTargetSettings;
  topology: DecodedTopology | null;
  tracker: Viewport3DResourceTracker;
  vectorScale: number;
}) {
  const geometry = useMemo(() => {
    if (!topology) return null;
    const surfaceIndices = buildPartSurfaceIndices(part, topology);
    if (!surfaceIndices?.length) return null;

    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute(
      "position",
      new BufferAttribute(buildTopologyPositions(topology), 3),
    );
    const colorBuffer = buildVertexScalarColors(fieldVector, topology.nodeCount);
    if (colorBuffer) {
      next.setAttribute("color", new BufferAttribute(colorBuffer.colors, 3));
    }
    next.setIndex(new BufferAttribute(surfaceIndices, 1));
    next.computeVertexNormals();
    return next;
  }, [fieldVector, part, topology, tracker]);

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);

  if (!geometry || !settings.visible) return null;

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
            vertexColors={geometry.hasAttribute("color")}
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
          fieldVector={fieldVector}
          nodeSelection={resolveMeshPartNodeSelection(part)}
          opacity={opacityFromSettings(settings)}
          scale={vectorScale}
          topology={topology}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

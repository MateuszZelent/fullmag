"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, DoubleSide } from "three";
import type { ColorRepresentation } from "three";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveMeshPartBounds,
  selectionForMeshPart,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type {
  Viewport3DBounds,
  Viewport3DFieldRenderModel,
  Viewport3DTopologyPartRenderModel,
  Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VectorFieldLayer } from "./VectorFieldLayer";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";

function opacityFromSettings(settings: VisualizationTargetSettings): number {
  return Math.max(0, Math.min(1, settings.opacityPercent / 100));
}

export function BoundsBox({
  bounds,
  color,
  opacity,
  wireframe = true,
}: {
  bounds: Viewport3DBounds | null;
  color: ColorRepresentation;
  opacity: number;
  wireframe?: boolean;
}) {
  if (!bounds) return null;

  return (
    <mesh position={bounds.center}>
      <boxGeometry
        args={[
          Math.max(bounds.size[0], 1e-9),
          Math.max(bounds.size[1], 1e-9),
          Math.max(bounds.size[2], 1e-9),
        ]}
      />
      <meshBasicMaterial
        color={color}
        opacity={opacity}
        transparent
        wireframe={wireframe}
      />
    </mesh>
  );
}

function BoundsPoints({
  bounds,
  color,
  opacity,
}: {
  bounds: Viewport3DBounds | null;
  color: ColorRepresentation;
  opacity: number;
}) {
  if (!bounds) return null;

  return (
    <points position={bounds.center}>
      <boxGeometry
        args={[
          Math.max(bounds.size[0], 1e-9),
          Math.max(bounds.size[1], 1e-9),
          Math.max(bounds.size[2], 1e-9),
        ]}
      />
      <pointsMaterial color={color} opacity={opacity} sizeAttenuation={false} size={3} transparent />
    </points>
  );
}

function AirboxMeshPartLayer({
  colors,
  fieldModel,
  onSelectPart,
  partModel,
  settings,
  topologyModel,
  tracker,
  vectorColorMode,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  fieldModel: Viewport3DFieldRenderModel | null;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>;
  settings: VisualizationTargetSettings;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart>;
  tracker: Viewport3DResourceTracker;
  vectorColorMode: string;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const geometry = useMemo(() => {
    const { surfaceIndices } = partModel;
    if (!surfaceIndices?.length) return null;
    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute("position", new BufferAttribute(topologyModel.positions, 3));
    next.setIndex(new BufferAttribute(surfaceIndices, 1));
    next.computeVertexNormals();
    return next;
  }, [partModel, topologyModel, tracker]);

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);

  const opacity = opacityFromSettings(settings);
  const part = partModel.part;

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectPart(selectionForMeshPart(part));
  };

  if (!geometry) {
    return (
      <group onPointerDown={handlePointerDown}>
        {settings.shaderVisible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={colors.accent}
            opacity={opacity}
            wireframe={false}
          />
        ) : null}
        {settings.wireframeVisible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={colors.wire}
            opacity={opacity}
          />
        ) : null}
        {settings.boundsVisible ? (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={colors.accent}
            opacity={Math.max(opacity, 0.35)}
          />
        ) : null}
        {settings.pointsVisible ? (
          <BoundsPoints
            bounds={resolveMeshPartBounds(part)}
            color={colors.wire}
            opacity={opacity}
          />
        ) : null}
        {settings.vectorsVisible ? (
          <VectorFieldLayer
            colors={colors}
            colorMode={vectorColorMode}
            opacity={opacity}
            segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
            style={vectorStyle}
            tracker={tracker}
          />
        ) : null}
      </group>
    );
  }

  return (
    <group onPointerDown={handlePointerDown}>
      {settings.shaderVisible ? (
        <mesh geometry={geometry}>
          <meshStandardMaterial
            color={colors.mesh}
            opacity={opacity}
            roughness={0.86}
            side={DoubleSide}
            transparent
          />
        </mesh>
      ) : null}
      {settings.wireframeVisible ? (
        settings.geometryScope === "surface" ? (
          <mesh geometry={geometry}>
            <meshBasicMaterial
              color={colors.wire}
              opacity={opacity}
              side={DoubleSide}
              transparent
              wireframe
            />
          </mesh>
        ) : (
          <BoundsBox
            bounds={resolveMeshPartBounds(part)}
            color={colors.wire}
            opacity={opacity}
          />
        )
      ) : null}
      {settings.boundsVisible ? (
        <BoundsBox
          bounds={resolveMeshPartBounds(part)}
          color={colors.accent}
          opacity={Math.max(opacity, 0.35)}
        />
      ) : null}
      {settings.pointsVisible ? (
        <points geometry={geometry}>
          <pointsMaterial
            color={colors.wire}
            opacity={opacity}
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
          opacity={opacity}
          segments={fieldModel?.partVectorSegments.get(part.id) ?? null}
          style={vectorStyle}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

export function DomainBoxLayer({
  bounds,
  colors,
  onSelectDomain,
}: {
  bounds: Viewport3DBounds | null;
  colors: Viewport3DColors;
  onSelectDomain: () => void;
}) {
  if (!bounds) return null;

  return (
    <mesh
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelectDomain();
      }}
      position={bounds.center}
    >
      <boxGeometry
        args={[
          Math.max(bounds.size[0], 1e-9),
          Math.max(bounds.size[1], 1e-9),
          Math.max(bounds.size[2], 1e-9),
        ]}
      />
      <meshBasicMaterial
        color={colors.accent}
        opacity={0.35}
        transparent
        wireframe
      />
    </mesh>
  );
}

export function AirboxLayer({
  colors,
  vectorColorMode,
  fieldModel,
  onSelectPart,
  settings,
  topologyModel,
  tracker,
  vectorStyle,
}: {
  colors: Viewport3DColors;
  vectorColorMode: string;
  fieldModel: Viewport3DFieldRenderModel | null;
  onSelectPart: (selection: Viewport3DPartSelection) => void;
  settings: VisualizationTargetSettings;
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  tracker: Viewport3DResourceTracker;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  if (!settings.visible) return null;

  return (
    <>
      {topologyModel?.airboxParts.map((partModel) => (
        <AirboxMeshPartLayer
          key={partModel.part.id}
          colors={colors}
          fieldModel={fieldModel}
          onSelectPart={onSelectPart}
          partModel={partModel}
          settings={settings}
          topologyModel={topologyModel}
          tracker={tracker}
          vectorColorMode={vectorColorMode}
          vectorStyle={vectorStyle}
        />
      ))}
    </>
  );
}

export function SelectionHighlightLayer({
  bounds,
  colors,
}: {
  bounds: Viewport3DBounds | null;
  colors: Viewport3DColors;
}) {
  return <BoundsBox bounds={bounds} color={colors.accent} opacity={0.72} />;
}

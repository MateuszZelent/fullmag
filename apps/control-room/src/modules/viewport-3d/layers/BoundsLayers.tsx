"use client";

import type {
  DecodedFieldVector,
  DecodedTopology,
} from "@/kernel/api/codecs";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import type { ColorRepresentation } from "three";

import {
  resolveMeshPartBounds,
  resolveMeshPartNodeSelection,
  type FemManifestRenderDomain,
} from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { VectorFieldLayer } from "./VectorFieldLayer";

function opacityFromSettings(settings: VisualizationTargetSettings): number {
  return Math.max(0, Math.min(1, settings.opacityPercent / 100));
}

function BoundsBox({
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
      <pointsMaterial color={color} opacity={opacity} size={0.01} transparent />
    </points>
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
  fieldVector,
  femDomain,
  settings,
  topology,
  tracker,
  vectorScale,
}: {
  colors: Viewport3DColors;
  fieldVector: DecodedFieldVector | null;
  femDomain: FemManifestRenderDomain;
  settings: VisualizationTargetSettings;
  topology: DecodedTopology | null;
  tracker: Viewport3DResourceTracker;
  vectorScale: number;
}) {
  if (!settings.visible) return null;

  return (
    <>
      {femDomain.airboxParts.map((part) => (
        <group key={part.id}>
          {settings.shaderVisible ? (
            <BoundsBox
              bounds={resolveMeshPartBounds(part)}
              color={colors.accent}
              opacity={opacityFromSettings(settings)}
              wireframe={false}
            />
          ) : null}
          {settings.wireframeVisible ? (
            <BoundsBox
              bounds={resolveMeshPartBounds(part)}
              color={colors.wire}
              opacity={opacityFromSettings(settings)}
            />
          ) : null}
          {settings.pointsVisible ? (
            <BoundsPoints
              bounds={resolveMeshPartBounds(part)}
              color={colors.wire}
              opacity={opacityFromSettings(settings)}
            />
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

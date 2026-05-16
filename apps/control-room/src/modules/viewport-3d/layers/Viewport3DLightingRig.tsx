"use client";

import type { ColorRepresentation } from "three";

import {
  getViewport3DVisualProfile,
  type Viewport3DVisualProfile,
  type Viewport3DVisualProfileId,
} from "../viewport3dVisualProfile";

export interface Viewport3DLightingRigModel {
  ambient: {
    color: ColorRepresentation;
    intensity: number;
  };
  directional: Array<{
    color: ColorRepresentation;
    intensity: number;
    position: [number, number, number];
  }>;
  hemisphere: {
    args: [ColorRepresentation, ColorRepresentation, number];
  } | null;
}

export function resolveViewport3DLightingRig(
  profile: Viewport3DVisualProfile,
): Viewport3DLightingRigModel {
  if (profile.lighting === "minimal") {
    return {
      ambient: { color: 0xffffff, intensity: 0.6 },
      directional: [],
      hemisphere: null,
    };
  }

  const figureBoost = profile.lighting === "figure" ? 1.12 : 1;
  return {
    ambient: {
      color: 0x8888aa,
      intensity: 0.72 * figureBoost,
    },
    directional: [
      {
        color: 0xffffff,
        intensity: 1.35 * figureBoost,
        position: [1.5, 2.5, 3.5],
      },
      {
        color: 0xccccff,
        intensity: 0.52 * figureBoost,
        position: [-1.8, 0.4, 1.2],
      },
      {
        color: 0xffffff,
        intensity: 0.34 * figureBoost,
        position: [0, -1.4, -2.4],
      },
    ],
    hemisphere: {
      args: [0x8898bf, 0x293245, 0.42 * figureBoost],
    },
  };
}

export function Viewport3DLightingRig({
  profileId,
}: {
  profileId: Viewport3DVisualProfileId;
}) {
  const rig = resolveViewport3DLightingRig(
    getViewport3DVisualProfile(profileId),
  );

  return (
    <>
      <ambientLight color={rig.ambient.color} intensity={rig.ambient.intensity} />
      {rig.directional.map((light) => (
        <directionalLight
          color={light.color}
          intensity={light.intensity}
          key={`${light.color}:${light.intensity}:${light.position.join(",")}`}
          position={light.position}
        />
      ))}
      {rig.hemisphere ? <hemisphereLight args={rig.hemisphere.args} /> : null}
    </>
  );
}

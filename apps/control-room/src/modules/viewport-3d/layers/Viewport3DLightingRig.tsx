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
  return {
    ambient: { color: 0xffffff, intensity: profile.lighting === "minimal" ? 0.6 : 0.72 },
    directional: [],
    hemisphere: null,
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

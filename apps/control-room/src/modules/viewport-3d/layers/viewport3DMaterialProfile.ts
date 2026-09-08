import type { MeshBasicMaterialParameters } from "three";

import type { Viewport3DVisualProfile } from "../viewport3dVisualProfile";

export interface Viewport3DMaterialProfile {
  airSurface: Pick<
    MeshBasicMaterialParameters,
    | "toneMapped"
  >;
  magneticSurface: Pick<
    MeshBasicMaterialParameters,
    | "toneMapped"
  > & {
    /**
     * Strength [0..1] of the cheap view-space-normal shading applied by the
     * custom scalar/orientation surface ShaderMaterial (see S-01). 0 keeps
     * the surface perfectly flat -- pure palette colors, no lighting-derived
     * modulation -- which is what publication/export profiles need for
     * color-accurate figures. A non-zero value adds just enough
     * normal-based brightness variation for the interactive viewport to
     * convey which face is being looked at.
     */
    shadeStrength: number;
  };
  primitivePreview: Pick<
    MeshBasicMaterialParameters,
    | "toneMapped"
  >;
  featureEdges: {
    opacity: number;
  };
  glyphs: {
    opacityScale: number;
    toneMapped: boolean;
  };
  grid: {
    depthTest: boolean;
    depthWrite: boolean;
    opacity: number;
    toneMapped: boolean;
  };
  axes: {
    depthTest: boolean;
    depthWrite: boolean;
    opacity: number;
    toneMapped: boolean;
  };
  dimensionFrame: {
    labelOpacity: number;
    majorOpacity: number;
    minorOpacity: number;
    tickOpacity: number;
  };
  selectionShell: {
    opacity: number;
  };
}

export function resolveViewport3DMaterialProfile(
  visualProfile: Viewport3DVisualProfile,
): Viewport3DMaterialProfile {
  const figureBoost = visualProfile.lighting === "figure" ? 1 : 0;
  return {
    airSurface: {
      toneMapped: visualProfile.toneMapping !== "none",
    },
    magneticSurface: {
      toneMapped: visualProfile.toneMapping !== "none",
      shadeStrength:
        visualProfile.id === "figure" || visualProfile.id === "capture"
          ? 0
          : 0.45,
    },
    primitivePreview: {
      toneMapped: visualProfile.toneMapping !== "none",
    },
    featureEdges: {
      opacity: Math.max(
        0,
        Math.min(1, visualProfile.edgeOpacity * visualProfile.edgeBoost),
      ),
    },
    glyphs: {
      opacityScale: visualProfile.lighting === "figure" ? 1 : 0.92,
      toneMapped: false,
    },
    grid: {
      depthTest: true,
      depthWrite: false,
      opacity: visualProfile.lighting === "minimal" ? 0.26 : 0.34,
      toneMapped: false,
    },
    axes: {
      depthTest: true,
      depthWrite: false,
      opacity: visualProfile.lighting === "minimal" ? 0.6 : 0.75,
      toneMapped: false,
    },
    dimensionFrame: {
      labelOpacity: visualProfile.lighting === "minimal" ? 0.76 : 0.9,
      majorOpacity: visualProfile.lighting === "minimal" ? 0.26 : 0.38 + figureBoost * 0.06,
      minorOpacity: visualProfile.lighting === "minimal" ? 0.14 : 0.22 + figureBoost * 0.04,
      tickOpacity: visualProfile.lighting === "minimal" ? 0.4 : 0.58 + figureBoost * 0.08,
    },
    selectionShell: {
      opacity: visualProfile.lighting === "figure" ? 0.82 : 0.72,
    },
  };
}

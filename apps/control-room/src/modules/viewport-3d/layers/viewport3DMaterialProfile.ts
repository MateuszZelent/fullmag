import type { MeshStandardMaterialParameters } from "three";

import type { Viewport3DVisualProfile } from "../viewport3dVisualProfile";

export interface Viewport3DMaterialProfile {
  airSurface: Pick<
    MeshStandardMaterialParameters,
    | "emissiveIntensity"
    | "metalness"
    | "roughness"
    | "toneMapped"
  >;
  magneticSurface: Pick<
    MeshStandardMaterialParameters,
    | "emissiveIntensity"
    | "metalness"
    | "roughness"
    | "toneMapped"
  >;
  primitivePreview: Pick<
    MeshStandardMaterialParameters,
    | "emissiveIntensity"
    | "metalness"
    | "roughness"
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
      emissiveIntensity: 0.02 + figureBoost * 0.02,
      metalness: 0,
      roughness: 0.92,
      toneMapped: visualProfile.toneMapping !== "none",
    },
    magneticSurface: {
      emissiveIntensity: 0,
      metalness: 0,
      roughness: visualProfile.lighting === "minimal" ? 0.88 : 0.72,
      toneMapped: visualProfile.toneMapping !== "none",
    },
    primitivePreview: {
      emissiveIntensity: 0.08 + figureBoost * 0.04,
      metalness: 0,
      roughness: 0.68,
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
    selectionShell: {
      opacity: visualProfile.lighting === "figure" ? 0.82 : 0.72,
    },
  };
}

"use client";

import type { QualityLevel } from "../MagnetizationView3D";

interface FdmLightingProps {
  brightness: number;
  quality: QualityLevel;
}

/**
 * Declarative R3F lighting rig for the FDM 3D viewport.
 *
 * Reproduces the exact same lighting setup as the former imperative
 * `initScene()` block: 3 directional lights, 1 ambient, 1 hemisphere
 * (when quality ≥ high).
 */
export default function FdmLighting({ brightness, quality }: FdmLightingProps) {
  const useLighting = quality !== "low";
  const useHemisphere = quality !== "low";

  if (!useLighting) {
    return <ambientLight intensity={0.6 * brightness} color={0xffffff} />;
  }

  return (
    <>
      {/* Key light */}
      <directionalLight
        position={[1, 2, 3]}
        intensity={1.8 * brightness}
        color={0xffffff}
      />
      {/* Fill light */}
      <directionalLight
        position={[-2, 0, 1]}
        intensity={0.8 * brightness}
        color={0xccccff}
      />
      {/* Back light */}
      <directionalLight
        position={[0, -1, -2]}
        intensity={0.5 * brightness}
        color={0xffffff}
      />
      {/* Ambient */}
      <ambientLight intensity={1.0 * brightness} color={0x8888aa} />
      {/* Hemisphere */}
      {useHemisphere && (
        <hemisphereLight
          args={[0x8898bf, 0x293245, 0.6 * brightness]}
        />
      )}
    </>
  );
}

"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";

export function VectorFieldLayer({
  colors,
  opacity = 1,
  segments,
  tracker,
}: {
  colors: Viewport3DColors;
  opacity?: number;
  segments: Float32Array | null;
  tracker: Viewport3DResourceTracker;
}) {
  const geometry = useMemo(() => {
    if (!segments) return null;

    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute("position", new BufferAttribute(segments, 3));
    return next;
  }, [segments, tracker]);

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);

  if (!geometry) return null;

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial
        color={colors.field}
        linewidth={1}
        opacity={opacity}
        transparent={opacity < 1}
      />
    </lineSegments>
  );
}

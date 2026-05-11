"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type {
  DecodedFieldVector,
  DecodedTopology,
} from "@/kernel/api/codecs";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import {
  buildVectorLineSegments,
  buildVectorLineSegmentsForNodeSelection,
  type Viewport3DNodeSelection,
} from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";

export function VectorFieldLayer({
  colors,
  fieldVector,
  nodeSelection,
  opacity = 1,
  scale,
  tracker,
  topology,
}: {
  colors: Viewport3DColors;
  fieldVector: DecodedFieldVector | null;
  nodeSelection?: Viewport3DNodeSelection | null;
  opacity?: number;
  scale: number;
  tracker: Viewport3DResourceTracker;
  topology: DecodedTopology | null;
}) {
  const geometry = useMemo(() => {
    const segments = nodeSelection
      ? buildVectorLineSegmentsForNodeSelection(
          topology,
          fieldVector,
          nodeSelection,
          scale,
        )
      : buildVectorLineSegments(topology, fieldVector, scale);
    if (!segments) return null;

    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute("position", new BufferAttribute(segments, 3));
    return next;
  }, [fieldVector, nodeSelection, scale, topology, tracker]);

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

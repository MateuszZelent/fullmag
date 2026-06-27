"use client";

import { useEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
} from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DMeshSizeHighlightModel } from "../viewport3dMeshSizeHighlight";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DColors } from "../viewport3dTypes";
import {
  RENDER_POLICIES,
  materialPolicyProps,
} from "./viewport3DRenderPolicy";

export function MeshSizeHighlightLayer({
  colors,
  model,
  tracker,
}: {
  colors: Viewport3DColors;
  model: Viewport3DMeshSizeHighlightModel | null;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate();
  const geometry = useMemo(() => {
    if (!model || model.edgeIndices.length === 0) return null;
    const next = new BufferGeometry();
    next.setAttribute("position", new BufferAttribute(model.positions, 3));
    next.setIndex(new BufferAttribute(model.edgeIndices, 1));
    return tracker.track("geometry", next);
  }, [model, tracker]);

  useEffect(
    () => () => tracker.release("geometry", geometry),
    [geometry, tracker],
  );
  useEffect(() => {
    if (!geometry) return;
    tracker.recordDirtyFrame("mesh-size-highlight");
    invalidate();
  }, [geometry, invalidate, tracker]);

  if (!geometry) return null;

  return (
    <lineSegments
      geometry={geometry}
      renderOrder={RENDER_POLICIES.featureEdges.renderOrder + 1}
    >
      <lineBasicMaterial
        color={colors.accentStrong ?? colors.accent}
        opacity={0.95}
        {...materialPolicyProps("featureEdges")}
      />
    </lineSegments>
  );
}

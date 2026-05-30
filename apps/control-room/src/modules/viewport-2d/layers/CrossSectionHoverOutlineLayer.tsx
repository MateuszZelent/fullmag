"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { buildViewport2DHoverOutlineModel } from "../viewport2dHoverOutlineModel";
import type {
  Viewport2DPolygonSummary,
  Viewport2DRenderModel,
} from "../viewport2dRenderModel";

export function CrossSectionHoverOutlineLayer({
  color = [1, 0.92, 0.32],
  model,
  opacity = 0.98,
  polygon,
  renderOrder = 5,
}: {
  color?: readonly [number, number, number];
  model: Viewport2DRenderModel;
  opacity?: number;
  polygon: Viewport2DPolygonSummary | null;
  renderOrder?: number;
}) {
  const outline = useMemo(
    () => buildViewport2DHoverOutlineModel(model, polygon),
    [model, polygon],
  );
  const geometry = useMemo(() => {
    if (!outline) return null;
    const next = new THREE.BufferGeometry();
    next.setAttribute(
      "position",
      new THREE.BufferAttribute(outline.positions, 3),
    );
    next.computeBoundingSphere();
    return next;
  }, [outline]);

  useEffect(() => {
    if (!geometry) return undefined;
    return () => geometry.dispose();
  }, [geometry]);

  if (!geometry) return null;

  return (
    <lineSegments geometry={geometry} renderOrder={renderOrder}>
      <lineBasicMaterial
        color={new THREE.Color(color[0], color[1], color[2])}
        depthTest={false}
        depthWrite={false}
        opacity={opacity}
        toneMapped={false}
        transparent
      />
    </lineSegments>
  );
}

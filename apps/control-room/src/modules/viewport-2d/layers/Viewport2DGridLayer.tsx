"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import {
  buildViewport2DGridModel,
  type Viewport2DGridBounds,
} from "../viewport2dGridModel";

export function Viewport2DGridLayer({
  bounds,
}: {
  bounds: Viewport2DGridBounds;
}) {
  const geometry = useMemo(() => {
    const grid = buildViewport2DGridModel(bounds);
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.BufferAttribute(grid.positions, 3));
    next.setAttribute("color", new THREE.BufferAttribute(grid.colors, 3));
    next.computeBoundingSphere();
    return next;
  }, [bounds]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} renderOrder={-1}>
      <lineBasicMaterial
        depthTest={false}
        depthWrite={false}
        opacity={0.62}
        toneMapped={false}
        transparent
        vertexColors
      />
    </lineSegments>
  );
}

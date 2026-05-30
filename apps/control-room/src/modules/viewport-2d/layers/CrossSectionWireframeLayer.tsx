"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import type { Viewport2DRenderModel } from "../viewport2dRenderModel";

export function CrossSectionWireframeLayer({
  model,
  wireframeColor = [0.85, 0.88, 0.92],
}: {
  model: Viewport2DRenderModel;
  wireframeColor?: readonly [number, number, number];
}) {
  const geometry = useMemo(() => {
    const positions = new Float32Array((model.segments.length / 4) * 6);
    for (let segment = 0; segment < model.segments.length / 4; segment++) {
      const source = segment * 4;
      const target = segment * 6;
      positions[target] = model.segments[source];
      positions[target + 1] = model.segments[source + 1];
      positions[target + 2] = 0.01;
      positions[target + 3] = model.segments[source + 2];
      positions[target + 4] = model.segments[source + 3];
      positions[target + 5] = 0.01;
    }
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    next.computeBoundingSphere();
    return next;
  }, [model]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={new THREE.Color(wireframeColor[0], wireframeColor[1], wireframeColor[2])} depthTest={false} />
    </lineSegments>
  );
}

"use client";

import { useFrame } from "@react-three/fiber";
import { useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { BufferGeometry, LineSegments } from "three";

import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import { useViewport3DGeometryUpload } from "../hooks/useViewport3DGeometryUpload";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { sampleViewport3DWireframeEdges, updateViewport3DInteractionWireframe } from "../viewport3dInteractionWireframe";
import { buildLineIndexGeometry } from "../viewport3dSurfaceEdges";

import { Viewport3DWireframeGestureContext } from "./Viewport3DInteractionWireframe.model";

export function Viewport3DInteractionWireframe({
  children,
  geometry,
  renderOrder,
  surfaceIndices,
  tracker,
}: {
  children: ReactNode;
  geometry: BufferGeometry;
  renderOrder: number;
  surfaceIndices?: Uint32Array | null;
  tracker: Viewport3DResourceTracker;
}) {
  const gesture = useContext(Viewport3DWireframeGestureContext);
  const line = useRef<LineSegments>(null);
  const invalidate = useBatchedInvalidate();
  const uploadManager = useMemo(() => createViewport3DGpuUploadManager({ policy: { targetFrameBudgetMs: 3 } }), []);
  useEffect(() => () => uploadManager.dispose(), [uploadManager]);
  const indices = useMemo(
    () => sampleViewport3DWireframeEdges(surfaceIndices?.length ? surfaceIndices : geometry.getIndex()?.array),
    [geometry, surfaceIndices],
  );
  const createGeometry = useCallback(() => {
    const positions = geometry.getAttribute("position")?.array;
    return positions instanceof Float32Array ? buildLineIndexGeometry(positions, indices) : null;
  }, [geometry, indices]);
  const interactionGeometry = useViewport3DGeometryUpload({
    createGeometry,
    dirtyReason: "mesh-part-wireframe",
    enabled: Boolean(gesture && indices?.length),
    estimatedBytes: indices?.byteLength ?? 0,
    invalidate,
    itemCount: indices?.length ?? 0,
    key: `interaction-wireframe:${geometry.uuid}`,
    lane: "topology-index",
    tracker,
    uploadManager,
  });
  useFrame(() => updateViewport3DInteractionWireframe(line.current, geometry, interactionGeometry, gesture));

  return <lineSegments ref={line} geometry={geometry} renderOrder={renderOrder}
    userData={{ viewportInteractionWireframe: true, fullGeometry: geometry.uuid, interactionGeometry: interactionGeometry?.uuid ?? null }}>
    {children}
  </lineSegments>;
}

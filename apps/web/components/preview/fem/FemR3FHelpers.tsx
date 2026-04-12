/**
 * Small R3F helper components extracted from FemMeshView3D.tsx.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { fitCameraToBounds } from "../camera/cameraHelpers";
import type { ClipAxis } from "../FemMeshView3D";

/** Manage WebGL clipping planes for mesh cross-section view. */
export function FemClipPlanes({ enabled, axis, posPercentage, flip = false, geomSize }: { enabled: boolean; axis: ClipAxis; posPercentage: number; flip?: boolean; geomSize: [number, number, number] }) {
  const { gl } = useThree();
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  useEffect(() => {
    rendererRef.current = gl;
  }, [gl]);
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    renderer.localClippingEnabled = enabled;
    if (!enabled) {
      renderer.clippingPlanes = [];
      return;
    }
    const axisSize = axis === "x" ? geomSize[0] : axis === "y" ? geomSize[1] : geomSize[2];
    const pos = ((posPercentage / 100) - 0.5) * axisSize;
    const sign = flip ? 1 : -1;
    const normal = new THREE.Vector3(axis === "x" ? sign : 0, axis === "y" ? sign : 0, axis === "z" ? sign : 0);
    renderer.clippingPlanes = [new THREE.Plane(normal, pos * sign)];
  }, [enabled, axis, posPercentage, flip, geomSize]);
  return null;
}

/** Auto-fit the R3F camera to the geometry bounding sphere whenever maxDim changes. */
export function CameraAutoFit({ maxDim, generation, controlsRef }: { maxDim: number; generation: number; controlsRef?: React.MutableRefObject<any> }) {
  const { camera, invalidate } = useThree();
  useEffect(() => {
    if (maxDim <= 0 || generation === 0) return;
    fitCameraToBounds(camera, maxDim, undefined, controlsRef?.current ?? undefined);
    invalidate();
  }, [camera, controlsRef, invalidate, maxDim, generation]);
  return null;
}

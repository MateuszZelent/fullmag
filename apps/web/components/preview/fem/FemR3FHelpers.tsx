/**
 * Small R3F helper components extracted from FemMeshView3D.tsx.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { fitCameraToBounds } from "../camera/cameraHelpers";
import type { ClipAxis } from "./femMeshTypes";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

const FEM_R3F_DEBUG_LOGS =
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace &&
  process.env.NODE_ENV !== "production";

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

/** Auto-fit the R3F camera to the geometry bounding sphere whenever maxDim changes.
 *
 * @param lastAppliedRef - Optional external ref for tracking the last applied generation/camera.
 *   Pass a ref that lives outside this component (e.g. in FemMeshView3D) so that the fit state
 *   survives scene remounts (missingExactScopeSegment toggle, context loss recovery).
 *   Without this, remounting CameraAutoFit resets lastApplied to {gen:0, camera:null} and
 *   immediately re-fires fitCameraToBounds for the current generation (P-19).
 */
export function CameraAutoFit({
  maxDim,
  generation,
  targetCenter,
  controlsRef,
  lastAppliedRef: externalLastAppliedRef,
  onFitApplied,
}: {
  maxDim: number;
  generation: number;
  targetCenter?: THREE.Vector3;
  controlsRef?: React.MutableRefObject<any>;
  lastAppliedRef?: React.MutableRefObject<{ generation: number; camera: THREE.Camera | null }>;
  onFitApplied?: () => void;
}) {
  const { camera, invalidate } = useThree();
  const internalLastAppliedRef = useRef<{ generation: number; camera: THREE.Camera | null }>({
    generation: 0,
    camera: null,
  });
  const lastAppliedRef = externalLastAppliedRef ?? internalLastAppliedRef;

  useEffect(() => {
    if (maxDim <= 0 || generation === 0) {
      return;
    }
    if (
      lastAppliedRef.current.generation === generation &&
      lastAppliedRef.current.camera === camera
    ) {
      return;
    }
    lastAppliedRef.current = { generation, camera };

    let raf = 0;
    let disposed = false;

    const syncFit = () => {
      if (disposed) {
        return;
      }

      fitCameraToBounds(
        camera,
        maxDim,
        targetCenter,
        controlsRef?.current ?? undefined,
      );
      onFitApplied?.();
      if (FEM_R3F_DEBUG_LOGS) {
        console.info("[viewport3d:fem] camera auto-fit applied", {
          generation,
          maxDim,
          targetCenter: targetCenter
            ? [targetCenter.x, targetCenter.y, targetCenter.z]
            : null,
        });
      }
      invalidate();

      if (!controlsRef?.current) {
        raf = window.requestAnimationFrame(syncFit);
      }
    };

    syncFit();

    return () => {
      disposed = true;
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [camera, controlsRef, generation, invalidate, maxDim, onFitApplied, targetCenter]);
  return null;
}

"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";

export function CanvasLifecycleProbe({
  tracker,
}: {
  tracker: Viewport3DResourceTracker;
}) {
  const { gl, invalidate } = useThree();

  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (event: Event) => {
      event.preventDefault();
      tracker.recordContextLost();
    };
    const onRestored = () => {
      tracker.recordContextRestored();
      tracker.recordDirtyFrame("context-restored");
      invalidate();
    };

    tracker.recordDirtyFrame("canvas-mounted");
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, [gl, invalidate, tracker]);

  return null;
}

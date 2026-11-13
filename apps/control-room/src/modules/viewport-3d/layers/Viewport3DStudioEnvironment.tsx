"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { PMREMGenerator, type Scene, type Texture, type WebGLRenderTarget } from "three";
import { createViewport3DStudioHdri } from "../viewport3dPresentation";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";

// Keep imperative Three.js scene ownership outside React's immutable hook values.
function setSceneEnvironment(scene: Scene, texture: Texture | null) {
  scene.environment = texture;
}

function setSceneEnvironmentIntensity(scene: Scene, intensity: number) {
  scene.environmentIntensity = intensity;
}

/** Owns the HDR panorama/PMREM; disabled scientific views allocate neither. */
export function Viewport3DStudioEnvironment({ enabled, intensity, tracker }: {
  enabled: boolean;
  intensity: number;
  tracker: Viewport3DResourceTracker;
}) {
  const { gl, scene } = useThree();
  const invalidate = useBatchedInvalidate("material-style");
  useEffect(() => {
    if (!enabled) return;
    const input = tracker.track("texture", createViewport3DStudioHdri(), { owner: "viewport-studio", label: "studio HDRI", byteLength: 256 * 128 * 16 });
    const generator = new PMREMGenerator(gl);
    let environment: WebGLRenderTarget;
    try {
      environment = tracker.track("render-target", generator.fromEquirectangular(input), { owner: "viewport-studio", label: "studio PMREM" });
    } finally {
      generator.dispose();
      tracker.release("texture", input);
    }
    const previous = scene.environment;
    setSceneEnvironment(scene, environment.texture);
    invalidate();
    return () => {
      if (scene.environment === environment.texture) setSceneEnvironment(scene, previous);
      tracker.release("render-target", environment);
      invalidate();
    };
  }, [enabled, gl, invalidate, scene, tracker]);
  useEffect(() => {
    if (!enabled) return;
    const previous = scene.environmentIntensity;
    setSceneEnvironmentIntensity(scene, intensity);
    invalidate();
    return () => { setSceneEnvironmentIntensity(scene, previous); };
  }, [enabled, intensity, invalidate, scene]);
  return null;
}

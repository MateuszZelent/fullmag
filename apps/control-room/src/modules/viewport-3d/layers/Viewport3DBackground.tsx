"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color, DataTexture } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import { createViewportBackgroundTexture } from "./Viewport3DBackground.model";

export function Viewport3DBackground({ colors, mode, strength, tracker }: {
  colors: Viewport3DColors;
  mode: "solid" | "gradient";
  strength: number;
  tracker: Viewport3DResourceTracker;
}) {
  const getThree = useThree((state) => state.get);
  const invalidate = useBatchedInvalidate("material-style");
  const background = useMemo(() => mode === "gradient"
    ? createViewportBackgroundTexture(colors, strength)
    : new Color(colors.background), [colors, mode, strength]);
  useEffect(() => {
    const scene = getThree().scene;
    const previous = scene.background;
    if (background instanceof DataTexture) tracker.track("texture", background);
    scene.background = background;
    tracker.recordDirtyFrame("material-style");
    invalidate();
    return () => {
      if (scene.background === background) scene.background = previous;
      if (background instanceof DataTexture) tracker.release("texture", background);
      invalidate();
    };
  }, [background, getThree, invalidate, tracker]);
  return null;
}

"use client";

import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useState } from "react";
import type { DimensionFramePixelRect } from "../layers/dimensionFrameLabelLayout";

function observeViewportHud(root: Element, measure: () => void) {
  const resize = new ResizeObserver(measure);
  const refresh = () => {
    resize.disconnect();
    resize.observe(root);
    for (const node of root.querySelectorAll(".fm-viewport-3d__hud, .fm-viewport-3d__colorbar-stack")) {
      resize.observe(node);
    }
    measure();
  };
  const mutations = new MutationObserver(refresh);
  const cleanup = () => {
    mutations.disconnect();
    resize.disconnect();
  };
  try {
    mutations.observe(root, { childList: true, subtree: true });
    refresh();
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}

/** Measures DOM chrome only on layout changes; camera frames reuse the same rectangles. */
export function useViewportHudRegions(viewCubeVisible: boolean, hslReferenceVisible: boolean): readonly DimensionFramePixelRect[] {
  const canvas = useThree((state) => state.gl.domElement);
  const size = useThree((state) => state.size);
  const [regions, setRegions] = useState<readonly DimensionFramePixelRect[]>([]);
  useLayoutEffect(() => {
    const root = canvas.closest(".fm-viewport-3d");
    if (!root) return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const compact = size.width < 640 || size.height < 420;
      const cube = compact ? 124 : 184;
      const hsl = compact ? 112 : 168;
      const next: DimensionFramePixelRect[] = [];
      if (viewCubeVisible) next.push({ left: size.width - cube, right: size.width, top: 0, bottom: cube });
      if (hslReferenceVisible) next.push({ left: 0, right: hsl, top: size.height - hsl, bottom: size.height });
      for (const node of root.querySelectorAll(".fm-viewport-3d__hud, .fm-viewport-3d__colorbar-stack")) {
        const bounds = node.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) next.push({ left: bounds.left - rect.left - 4, right: bounds.right - rect.left + 4, top: bounds.top - rect.top - 4, bottom: bounds.bottom - rect.top + 4 });
      }
      setRegions((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    return observeViewportHud(root, measure);
  }, [canvas, hslReferenceVisible, size.height, size.width, viewCubeVisible]);
  return regions;
}

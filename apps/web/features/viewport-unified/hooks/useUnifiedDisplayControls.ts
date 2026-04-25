/**
 * Unified display-control actions.
 *
 * Uses the canonical resource-first display patch API.
 */

import { useCallback } from "react";
import { displayPatchFromPreviewComponent } from "@/src/api/displaySelection";
import type { DisplayPatchRequest } from "@/src/api/types";

export function useUnifiedDisplayControls(
  updateDisplay: (update: DisplayPatchRequest) => Promise<void>,
) {
  const setComponent = useCallback(
    (component: string) => {
      return updateDisplay(displayPatchFromPreviewComponent(
        component === "3D" ||
          component === "x" ||
          component === "y" ||
          component === "z" ||
          component === "magnitude"
          ? component
          : "magnitude",
      ));
    },
    [updateDisplay],
  );

  const setEveryN = useCallback(
    (everyN: number) => updateDisplay({ vector_density: everyN }),
    [updateDisplay],
  );

  const setMaxPoints = useCallback(
    (maxPoints: number) => updateDisplay({ max_points: maxPoints }),
    [updateDisplay],
  );

  const setAutoScale = useCallback(
    (enabled: boolean) => updateDisplay({ auto_contrast: enabled }),
    [updateDisplay],
  );

  const setLayer = useCallback(
    (layer: number) => updateDisplay({ slice_layer: layer }),
    [updateDisplay],
  );

  const setAllLayers = useCallback(
    (all: boolean) => updateDisplay({ slice_mode: all ? "all" : "single" }),
    [updateDisplay],
  );

  const setColormap = useCallback(
    (colormap: string) => updateDisplay({ colormap }),
    [updateDisplay],
  );

  const setQuantity = useCallback(
    (quantityId: string) => updateDisplay({ active_quantity_id: quantityId }),
    [updateDisplay],
  );

  const setVectorGlyphs = useCallback(
    (enabled: boolean) => updateDisplay({ vector_glyphs: enabled }),
    [updateDisplay],
  );

  const setContrastRange = useCallback(
    (min: number, max: number) => updateDisplay({ contrast_min: min, contrast_max: max }),
    [updateDisplay],
  );

  return {
    setComponent,
    setEveryN,
    setMaxPoints,
    setAutoScale,
    setLayer,
    setAllLayers,
    setColormap,
    setQuantity,
    setVectorGlyphs,
    setContrastRange,
  };
}

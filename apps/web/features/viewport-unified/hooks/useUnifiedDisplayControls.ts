/**
 * Unified display-control actions.
 *
 * Bridges legacy preview-mutation calls with the canonical resource-first
 * DisplayUpdate API, falling back to legacy preview posts only when a caller
 * does not provide the new update handler.
 */

import { useCallback } from "react";
import type { DisplayUpdate } from "../../../src/api/types";

export function useUnifiedDisplayControls(
  legacyUpdatePreview:
    | ((path: string, payload?: Record<string, unknown>) => Promise<void>)
    | null,
  newDisplayUpdate: ((update: DisplayUpdate) => Promise<void>) | null,
) {
  const setComponent = useCallback(
    (component: string) => {
      if (newDisplayUpdate) {
        return newDisplayUpdate({ component });
      }
      return legacyUpdatePreview?.("/component", { component });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setEveryN = useCallback(
    (everyN: number) => {
      if (newDisplayUpdate) {
        return newDisplayUpdate({ vector_density: everyN });
      }
      return legacyUpdatePreview?.("/everyN", { everyN });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setMaxPoints = useCallback(
    (maxPoints: number) => {
      if (newDisplayUpdate) {
        return Promise.resolve(void maxPoints);
      }
      return legacyUpdatePreview?.("/maxPoints", { maxPoints });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setAutoScale = useCallback(
    (enabled: boolean) => {
      if (newDisplayUpdate) {
        return newDisplayUpdate({ auto_contrast: enabled });
      }
      return legacyUpdatePreview?.("/autoScaleEnabled", {
        autoScaleEnabled: enabled,
      });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setLayer = useCallback(
    (layer: number) => {
      if (newDisplayUpdate) {
        return newDisplayUpdate({ slice_layer: layer });
      }
      return legacyUpdatePreview?.("/layer", { layer });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setAllLayers = useCallback(
    (all: boolean) => {
      if (newDisplayUpdate) {
        return newDisplayUpdate({ slice_mode: all ? "all" : "single" });
      }
      return legacyUpdatePreview?.("/allLayers", { allLayers: all });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setColormap = useCallback(
    (colormap: string) => {
      if (newDisplayUpdate) {
        return newDisplayUpdate({ colormap });
      }
      return legacyUpdatePreview?.("/colormap", { colormap });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setQuantity = useCallback(
    (quantityId: string) => {
      if (newDisplayUpdate) {
        return newDisplayUpdate({ active_quantity_id: quantityId });
      }
      return legacyUpdatePreview?.("/selection", { quantityId });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setVectorGlyphs = useCallback(
    (enabled: boolean) => {
      if (newDisplayUpdate) {
        return newDisplayUpdate({ vector_glyphs: enabled });
      }
      return legacyUpdatePreview?.("/vectorGlyphs", {
        vectorGlyphs: enabled,
      });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setContrastRange = useCallback(
    (min: number, max: number) => {
      if (newDisplayUpdate) {
        return newDisplayUpdate({ contrast_min: min, contrast_max: max });
      }
      return legacyUpdatePreview?.("/contrastRange", { min, max });
    },
    [legacyUpdatePreview, newDisplayUpdate],
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

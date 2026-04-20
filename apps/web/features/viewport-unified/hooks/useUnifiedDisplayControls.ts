/**
 * Unified display-control actions.
 *
 * Bridges legacy preview-mutation calls with the new resource-first
 * DisplayUpdate API behind the USE_NEW_API feature flag.
 */

import { useCallback } from "react";
import { USE_NEW_API } from "../../../src/config/featureFlags";
import type { DisplayUpdate } from "../../../src/api/types";

export function useUnifiedDisplayControls(
  legacyUpdatePreview:
    | ((path: string, payload?: Record<string, unknown>) => Promise<void>)
    | null,
  newDisplayUpdate: ((update: DisplayUpdate) => Promise<void>) | null,
) {
  const setComponent = useCallback(
    (component: string) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({ component });
      }
      return legacyUpdatePreview?.("/component", { component });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setEveryN = useCallback(
    (everyN: number) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({ component: String(everyN) });
      }
      return legacyUpdatePreview?.("/everyN", { everyN });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setMaxPoints = useCallback(
    (maxPoints: number) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({ component: String(maxPoints) });
      }
      return legacyUpdatePreview?.("/maxPoints", { maxPoints });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setAutoScale = useCallback(
    (enabled: boolean) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({
          range_min: enabled ? null : undefined,
          range_max: enabled ? null : undefined,
        });
      }
      return legacyUpdatePreview?.("/autoScaleEnabled", {
        autoScaleEnabled: enabled,
      });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setLayer = useCallback(
    (layer: number) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({ component: String(layer) });
      }
      return legacyUpdatePreview?.("/layer", { layer });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setAllLayers = useCallback(
    (all: boolean) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({ component: all ? "all" : "single" });
      }
      return legacyUpdatePreview?.("/allLayers", { allLayers: all });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setColormap = useCallback(
    (colormap: string) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({ colormap });
      }
      return legacyUpdatePreview?.("/colormap", { colormap });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setQuantity = useCallback(
    (quantityId: string) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({ quantity_id: quantityId });
      }
      return legacyUpdatePreview?.("/selection", { quantityId });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setVectorGlyphs = useCallback(
    (enabled: boolean) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({ component: enabled ? "3D" : "magnitude" });
      }
      return legacyUpdatePreview?.("/vectorGlyphs", {
        vectorGlyphs: enabled,
      });
    },
    [legacyUpdatePreview, newDisplayUpdate],
  );

  const setContrastRange = useCallback(
    (min: number, max: number) => {
      if (USE_NEW_API && newDisplayUpdate) {
        return newDisplayUpdate({ range_min: min, range_max: max });
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

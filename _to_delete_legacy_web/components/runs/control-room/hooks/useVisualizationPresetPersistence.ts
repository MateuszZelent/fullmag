import { useEffect } from "react";
import type {
  VisualizationPreset,
  VisualizationPresetRef,
} from "@/lib/session/types";
import {
  LOCAL_ACTIVE_VISUALIZATION_PRESET_STORAGE_KEY,
  LOCAL_VISUALIZATION_PRESETS_STORAGE_KEY,
} from "../visualizationPresets";

export function useVisualizationPresetPersistence({
  activeVisualizationPresetRef,
  localVisualizationPresets,
}: {
  activeVisualizationPresetRef: VisualizationPresetRef | null;
  localVisualizationPresets: VisualizationPreset[];
}) {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(
        LOCAL_VISUALIZATION_PRESETS_STORAGE_KEY,
        JSON.stringify(localVisualizationPresets),
      );
    } catch {
      // Ignore storage failures (private mode / quota).
    }
  }, [localVisualizationPresets]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      if (activeVisualizationPresetRef) {
        window.localStorage.setItem(
          LOCAL_ACTIVE_VISUALIZATION_PRESET_STORAGE_KEY,
          JSON.stringify(activeVisualizationPresetRef),
        );
      } else {
        window.localStorage.removeItem(LOCAL_ACTIVE_VISUALIZATION_PRESET_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures (private mode / quota).
    }
  }, [activeVisualizationPresetRef]);
}

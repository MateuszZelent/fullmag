"use client";

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { VisualizationPresetFdmState } from "@/lib/session/types";
import {
  settingsFromPreset,
  settingsToPreset,
  type VectorSurfaceViewportSettings,
  type VectorSurfaceViewportVoxelSampling as VoxelSampling,
} from "./fdm/fdmViewportSettingsTypes";

export type {
  VectorSurfaceViewportSettings,
  VectorSurfaceViewportQualityLevel as QualityLevel,
  VectorSurfaceViewportRenderMode as RenderMode,
  VectorSurfaceViewportTopoComponent as TopoComponent,
  VectorSurfaceViewportVoxelColorMode as VoxelColorMode,
  VectorSurfaceViewportVoxelSampling as VoxelSampling,
  FdmViewportSettings,
  FdmViewportQualityLevel,
  FdmViewportRenderMode,
  FdmViewportTopoComponent,
  FdmViewportVoxelColorMode,
  FdmViewportVoxelSampling,
} from "./fdm/fdmViewportSettingsTypes";

const STORAGE_KEYS = {
  brightness: "preview3d_brightness",
  quality: "preview3d_quality",
  renderMode: "preview3d_render_mode",
  voxelOpacity: "preview3d_voxel_opacity",
  voxelGap: "preview3d_voxel_gap",
  voxelThreshold: "preview3d_voxel_threshold",
  voxelColorMode: "preview3d_voxel_color_mode",
  voxelSampling: "preview3d_voxel_sampling",
  topoEnabled: "preview3d_topo_enabled",
  topoComponent: "preview3d_topo_component",
  topoMultiplier: "preview3d_topo_multiplier",
} as const;

function loadClamped(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") {
    return fallback;
  }
  const raw = Number.parseFloat(window.localStorage.getItem(key) || "");
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, raw));
}

function loadEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.localStorage.getItem(key) as T | null;
  return value && allowed.includes(value) ? value : fallback;
}

function persist(key: string, value: string | number | boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(key, String(value));
}

function loadSettings(): VectorSurfaceViewportSettings {
  const rawSampling = loadEnum(STORAGE_KEYS.voxelSampling, ["1", "2", "4"] as const, "1");
  const sampling: VoxelSampling = rawSampling === "2" ? 2 : rawSampling === "4" ? 4 : 1;
  return {
    quality: loadEnum(STORAGE_KEYS.quality, ["low", "high", "ultra"] as const, "high"),
    renderMode: loadEnum(STORAGE_KEYS.renderMode, ["glyph", "voxel"] as const, "glyph"),
    voxelColorMode: loadEnum(
      STORAGE_KEYS.voxelColorMode,
      ["orientation", "x", "y", "z"] as const,
      "orientation",
    ),
    sampling,
    brightness: loadClamped(STORAGE_KEYS.brightness, 1.5, 0.3, 3.0),
    voxelOpacity: loadClamped(STORAGE_KEYS.voxelOpacity, 0.5, 0.15, 0.95),
    voxelGap: loadClamped(STORAGE_KEYS.voxelGap, 0.14, 0.02, 0.42),
    voxelThreshold: loadClamped(STORAGE_KEYS.voxelThreshold, 0.08, 0, 0.95),
    topoEnabled:
      typeof window !== "undefined" &&
      window.localStorage.getItem(STORAGE_KEYS.topoEnabled) === "true",
    topoComponent: loadEnum(STORAGE_KEYS.topoComponent, ["x", "y", "z"] as const, "z"),
    topoMultiplier: loadClamped(STORAGE_KEYS.topoMultiplier, 5, 0.5, 50),
  };
}

function persistPatch(
  next: VectorSurfaceViewportSettings,
  patch: Partial<VectorSurfaceViewportSettings>,
): void {
  if (patch.quality !== undefined) persist(STORAGE_KEYS.quality, next.quality);
  if (patch.renderMode !== undefined) persist(STORAGE_KEYS.renderMode, next.renderMode);
  if (patch.voxelColorMode !== undefined) persist(STORAGE_KEYS.voxelColorMode, next.voxelColorMode);
  if (patch.sampling !== undefined) persist(STORAGE_KEYS.voxelSampling, next.sampling);
  if (patch.brightness !== undefined) persist(STORAGE_KEYS.brightness, next.brightness);
  if (patch.voxelOpacity !== undefined) persist(STORAGE_KEYS.voxelOpacity, next.voxelOpacity);
  if (patch.voxelGap !== undefined) persist(STORAGE_KEYS.voxelGap, next.voxelGap);
  if (patch.voxelThreshold !== undefined) persist(STORAGE_KEYS.voxelThreshold, next.voxelThreshold);
  if (patch.topoEnabled !== undefined) persist(STORAGE_KEYS.topoEnabled, next.topoEnabled);
  if (patch.topoComponent !== undefined) persist(STORAGE_KEYS.topoComponent, next.topoComponent);
  if (patch.topoMultiplier !== undefined) persist(STORAGE_KEYS.topoMultiplier, next.topoMultiplier);
}

export function useVectorSurfaceViewportSettings(args: {
  externalSettings?: VisualizationPresetFdmState;
  onSettingsChange?: Dispatch<SetStateAction<VisualizationPresetFdmState>>;
}): {
  settings: VectorSurfaceViewportSettings;
  update: (patch: Partial<VectorSurfaceViewportSettings>) => void;
} {
  const { externalSettings, onSettingsChange } = args;
  const [internalSettings, setInternalSettings] = useState<VectorSurfaceViewportSettings>(loadSettings);
  const settings = useMemo(
    () => (externalSettings ? settingsFromPreset(externalSettings) : internalSettings),
    [externalSettings, internalSettings],
  );

  const update = useCallback(
    (patch: Partial<VectorSurfaceViewportSettings>) => {
      const patchSettings = (
        previous: VectorSurfaceViewportSettings,
      ): VectorSurfaceViewportSettings => {
        const next = { ...previous, ...patch };
        persistPatch(next, patch);
        return next;
      };

      if (externalSettings && onSettingsChange) {
        onSettingsChange((previous) => settingsToPreset(patchSettings(settingsFromPreset(previous))));
        return;
      }

      setInternalSettings((previous) => patchSettings(previous));
    },
    [externalSettings, onSettingsChange],
  );

  return { settings, update };
}

export const useFdmViewportSettings = useVectorSurfaceViewportSettings;

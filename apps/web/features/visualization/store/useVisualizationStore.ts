/**
 * useVisualizationStore — Zustand store for viewport visualization state
 *
 * Extracted from ControlRoomContext (Phase 2, Etap 2.1).
 *
 * Owns all rendering parameters that the 3D viewport needs:
 *   - mesh render mode, opacity, clip plane
 *   - FEM arrow/vector styling
 *   - FEM viewport layer visibility
 *   - airbox visibility/opacity
 *   - viewport legend, axes scope, wireframe
 *   - FDM visualization settings
 *   - visualization presets
 *
 * Phase 2.1 (PR 1): Store creation with types, defaults, and selectors.
 * Phase 2.1 (PR 2): ControlRoomContext writes to this store in parallel.
 * Phase 2.1 (PR 3): Consumer migration from useModel() to useVisualizationStore().
 * Phase 2.1 (PR 4): Remove duplicated state from ModelCtx.
 */

import { create } from "zustand";
import type { SetStateAction } from "react";
import type { RenderMode } from "@/components/preview/FemMeshView3D";
import type {
  ResolvedRenderPlan,
  ViewportVisualizationState,
} from "@/components/runs/control-room/visualizationStateSync";
import { projectResolvedRenderPlanToViewportState } from "@/components/runs/control-room/visualizationStateSync";
import type { ClipAxis } from "@/components/preview/fem/femMeshTypes";
import type {
  FemViewportLayerState,
} from "@/features/viewport-unified/model/unifiedViewportTypes";
import {
  DEFAULT_FEM_VIEWPORT_LAYER_STATE,
} from "@/features/viewport-unified/model/unifiedViewportTypes";
import type {
  VisualizationPresetFdmState,
  VisualizationPreset,
  VisualizationPresetRef,
  VisualizationPresetSource,
} from "@/lib/session/types";
import type { FemVectorDomainFilter } from "@/components/runs/control-room/visualizationStateSync";
import type {
  FemArrowColorMode,
  FemFerromagnetVisibilityMode,
} from "@/components/preview/fem/femMeshTypes";
import {
  DEFAULT_AIR_MESH_OPACITY,
  DEFAULT_FDM_VISUALIZATION_SETTINGS,
  loadLocalActiveVisualizationRef,
  loadLocalVisualizationPresets,
} from "@/components/runs/control-room/controlRoomUtils";

/* ══════════════════════════════════════════════════════════════════
 * Types
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Core viewport visualization state — matches `ViewportVisualizationState`
 * from visualizationStateSync.ts exactly (canonical source of truth).
 */
export interface ViewportVizCore {
  meshRenderMode: RenderMode;
  meshOpacity: number;
  meshClipEnabled: boolean;
  meshClipAxis: ClipAxis;
  meshClipPos: number;
  meshClipFlip: boolean;
  meshShowArrows: boolean;
  femVectorGlyphBudget: number;
  femArrowColorMode: FemArrowColorMode;
  femArrowMonoColor: string;
  femArrowAlpha: number;
  femArrowLengthScale: number;
  femArrowThickness: number;
  femVectorDomainFilter: FemVectorDomainFilter;
  femFerromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  femViewportLayers: FemViewportLayerState;
  airMeshVisible: boolean;
  airMeshOpacity: number;
}

/** Extended visualization state including viewport chrome and presets. */
export interface VisualizationStoreState extends ViewportVizCore {
  /* Viewport chrome */
  femTextureDownsampleCells: number;
  viewportLegendVisible: boolean;
  viewportAxesScope: "universe" | "object";
  universeWireframeVisible: boolean;

  /* FDM visualization */
  fdmVisualizationSettings: VisualizationPresetFdmState;

  /** Resolved render plan from the backend visualization state resource. */
  resolvedRenderPlan: ResolvedRenderPlan | null;

  /* Presets */
  visualizationProjectPresets: VisualizationPreset[];
  visualizationLocalPresets: VisualizationPreset[];
  activeVisualizationPresetRef: VisualizationPresetRef | null;

  /* ── Actions ── */

  /** Batch-update core viewport viz fields (from render plan projection). */
  setCore: (core: ViewportVizCore) => void;

  /** Apply a canonical render-plan projection. */
  applyFromRenderPlan: (core: ViewportVizCore) => void;

  /** Apply visualization fields restored from a user preset. */
  applyFromPreset: (partial: Partial<ViewportVizCore>) => void;

  /** Patch individual fields (for UI controls). */
  patch: (partial: Partial<ViewportVizCore>) => void;

  /** Reset to initial defaults. */
  resetToDefaults: () => void;

  /* Chrome setters */
  setFemTextureDownsampleCells: (v: number) => void;
  setViewportLegendVisible: (v: boolean) => void;
  setViewportAxesScope: (v: "universe" | "object") => void;
  setUniverseWireframeVisible: (v: boolean) => void;
  setFdmVisualizationSettings: (v: VisualizationPresetFdmState) => void;
  setResolvedRenderPlan: (v: ResolvedRenderPlan | null) => void;

  /* Preset management */
  setVisualizationProjectPresets: (v: SetStateAction<VisualizationPreset[]>) => void;
  setVisualizationLocalPresets: (v: SetStateAction<VisualizationPreset[]>) => void;
  setActiveVisualizationPresetRef: (v: SetStateAction<VisualizationPresetRef | null>) => void;
}

/* ══════════════════════════════════════════════════════════════════
 * Defaults
 * ══════════════════════════════════════════════════════════════════ */


export const DEFAULT_CORE: ViewportVizCore = {
  meshRenderMode: "surface",
  meshOpacity: 100,
  meshClipEnabled: false,
  meshClipAxis: "x",
  meshClipPos: 50,
  meshClipFlip: false,
  meshShowArrows: false,
  femVectorGlyphBudget: 1_200,
  femArrowColorMode: "orientation",
  femArrowMonoColor: "#00c2ff",
  femArrowAlpha: 1,
  femArrowLengthScale: 1,
  femArrowThickness: 1,
  femVectorDomainFilter: "auto",
  femFerromagnetVisibilityMode: "hide",
  femViewportLayers: DEFAULT_FEM_VIEWPORT_LAYER_STATE,
  airMeshVisible: false,
  airMeshOpacity: DEFAULT_AIR_MESH_OPACITY,
};

const INITIAL_STATE: Omit<VisualizationStoreState,
  | "setCore" | "applyFromRenderPlan" | "applyFromPreset" | "patch" | "resetToDefaults"
  | "setFemTextureDownsampleCells" | "setViewportLegendVisible"
  | "setViewportAxesScope" | "setUniverseWireframeVisible"
  | "setFdmVisualizationSettings" | "setResolvedRenderPlan"
  | "setVisualizationProjectPresets" | "setVisualizationLocalPresets"
  | "setActiveVisualizationPresetRef"
> = {
  ...DEFAULT_CORE,
  femTextureDownsampleCells: 65_536,
  viewportLegendVisible: false,
  viewportAxesScope: "universe",
  universeWireframeVisible: true,
  fdmVisualizationSettings: DEFAULT_FDM_VISUALIZATION_SETTINGS,
  resolvedRenderPlan: null,
  visualizationProjectPresets: [],
  visualizationLocalPresets: loadLocalVisualizationPresets(),
  activeVisualizationPresetRef: loadLocalActiveVisualizationRef(),
};

function resolveSetStateAction<T>(value: SetStateAction<T>, previous: T): T {
  return typeof value === "function"
    ? (value as (prev: T) => T)(previous)
    : value;
}

function stableSerialize(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function sameResolvedRenderPlan(
  left: ResolvedRenderPlan | null,
  right: ResolvedRenderPlan | null,
): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (!left || !right) {
    return left === right;
  }
  const serializedLeft = stableSerialize(left);
  const serializedRight = stableSerialize(right);
  return serializedLeft !== null && serializedLeft === serializedRight;
}

/* ══════════════════════════════════════════════════════════════════
 * Store
 * ══════════════════════════════════════════════════════════════════ */

export const useVisualizationStore = create<VisualizationStoreState>((set) => ({
  ...INITIAL_STATE,

  setCore: (core) =>
    set((prev) => {
      // Structural sharing: only update if at least one field changed
      let changed = false;
      const keys = Object.keys(core) as (keyof ViewportVizCore)[];
      for (const k of keys) {
        if (!Object.is(prev[k], core[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      return { ...prev, ...core };
    }),

  applyFromRenderPlan: (core) =>
    set((prev) => {
      let changed = false;
      const keys = Object.keys(core) as (keyof ViewportVizCore)[];
      for (const k of keys) {
        if (!Object.is(prev[k], core[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      return { ...prev, ...core };
    }),

  applyFromPreset: (partial) =>
    set((prev) => {
      let changed = false;
      const keys = Object.keys(partial) as (keyof ViewportVizCore)[];
      for (const k of keys) {
        if (!Object.is(prev[k], partial[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      return { ...prev, ...partial };
    }),

  patch: (partial) =>
    set((prev) => {
      let changed = false;
      const keys = Object.keys(partial) as (keyof ViewportVizCore)[];
      for (const k of keys) {
        if (!Object.is(prev[k], partial[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      return { ...prev, ...partial };
    }),

  resetToDefaults: () => set(INITIAL_STATE),

  setFemTextureDownsampleCells: (v) => set({ femTextureDownsampleCells: v }),
  setViewportLegendVisible: (v) => set({ viewportLegendVisible: v }),
  setViewportAxesScope: (v) => set({ viewportAxesScope: v }),
  setUniverseWireframeVisible: (v) => set({ universeWireframeVisible: v }),
  setFdmVisualizationSettings: (v) => set({ fdmVisualizationSettings: v }),
  setResolvedRenderPlan: (v) =>
    set((prev) => {
      if (sameResolvedRenderPlan(prev.resolvedRenderPlan, v)) {
        return prev;
      }
      return { resolvedRenderPlan: v };
    }),

  setVisualizationProjectPresets: (v) =>
    set((prev) => ({
      visualizationProjectPresets: resolveSetStateAction(v, prev.visualizationProjectPresets),
    })),
  setVisualizationLocalPresets: (v) =>
    set((prev) => ({
      visualizationLocalPresets: resolveSetStateAction(v, prev.visualizationLocalPresets),
    })),
  setActiveVisualizationPresetRef: (v) =>
    set((prev) => ({
      activeVisualizationPresetRef: resolveSetStateAction(v, prev.activeVisualizationPresetRef),
    })),
}));

/* ══════════════════════════════════════════════════════════════════
 * Selectors — for use in hot paths (subscribe to minimal slices)
 * ══════════════════════════════════════════════════════════════════ */

// Core rendering
export const selectMeshRenderMode = (s: VisualizationStoreState) => s.meshRenderMode;
export const selectMeshOpacity = (s: VisualizationStoreState) => s.meshOpacity;

// Clip plane
export const selectClipEnabled = (s: VisualizationStoreState) => s.meshClipEnabled;
export const selectClipAxis = (s: VisualizationStoreState) => s.meshClipAxis;
export const selectClipPos = (s: VisualizationStoreState) => s.meshClipPos;
export const selectClipFlip = (s: VisualizationStoreState) => s.meshClipFlip;

// Vectors / arrows
export const selectMeshShowArrows = (s: VisualizationStoreState) => s.meshShowArrows;
export const selectFemArrowColorMode = (s: VisualizationStoreState) => s.femArrowColorMode;
export const selectFemArrowAlpha = (s: VisualizationStoreState) => s.femArrowAlpha;
export const selectFemArrowLengthScale = (s: VisualizationStoreState) => s.femArrowLengthScale;
export const selectFemArrowThickness = (s: VisualizationStoreState) => s.femArrowThickness;
export const selectFemArrowMonoColor = (s: VisualizationStoreState) => s.femArrowMonoColor;
export const selectFemVectorGlyphBudget = (s: VisualizationStoreState) => s.femVectorGlyphBudget;
export const selectFemVectorDomainFilter = (s: VisualizationStoreState) => s.femVectorDomainFilter;
export const selectFemFerromagnetVisibilityMode = (s: VisualizationStoreState) => s.femFerromagnetVisibilityMode;

// FEM layers
export const selectFemViewportLayers = (s: VisualizationStoreState) => s.femViewportLayers;

// Airbox
export const selectAirMeshVisible = (s: VisualizationStoreState) => s.airMeshVisible;
export const selectAirMeshOpacity = (s: VisualizationStoreState) => s.airMeshOpacity;

// Chrome
export const selectFemTextureDownsampleCells = (s: VisualizationStoreState) => s.femTextureDownsampleCells;
export const selectViewportLegendVisible = (s: VisualizationStoreState) => s.viewportLegendVisible;
export const selectViewportAxesScope = (s: VisualizationStoreState) => s.viewportAxesScope;
export const selectUniverseWireframeVisible = (s: VisualizationStoreState) => s.universeWireframeVisible;

// FDM
export const selectFdmVisualizationSettings = (s: VisualizationStoreState) => s.fdmVisualizationSettings;

// Render plan
export const selectResolvedRenderPlan = (s: VisualizationStoreState) => s.resolvedRenderPlan;

// Presets
export const selectVisualizationProjectPresets = (s: VisualizationStoreState) => s.visualizationProjectPresets;
export const selectVisualizationLocalPresets = (s: VisualizationStoreState) => s.visualizationLocalPresets;
export const selectActiveVisualizationPresetRef = (s: VisualizationStoreState) => s.activeVisualizationPresetRef;

/**
 * Derive the effective viewport visualization state from the store.
 * This projects the resolved render plan onto the base viz core state,
 * providing the same semantics as the old CRC `effectiveViewportVisualizationState`.
 */
export function selectEffectiveViewportVizState(
  s: VisualizationStoreState,
): ViewportVisualizationState {
  return projectResolvedRenderPlanToViewportState(s.resolvedRenderPlan, s);
}

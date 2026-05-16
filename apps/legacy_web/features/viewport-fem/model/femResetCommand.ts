/**
 * Layer D – FEM Viewport Engine: Reset Command
 *
 * Pure function that produces a reset patch for viewport display state.
 * Replaces the scattered implicit resets (mode-triggered) with an
 * explicit user-initiated action, scoped to the current selection.
 */

import type { FemMeshPart, MeshEntityViewState, MeshEntityViewStateMap } from "../../../lib/session/types";
import { defaultMeshEntityViewState } from "../../../lib/session/types";
import type { VisualizationStatePatch } from "@/src/api/types";
import type { ViewportSelectionScope } from "./femViewportSelection";
import { scopeTargetPartIds } from "./femViewportSelection";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

/* ── Types ──────────────────────────────────────────────────────── */

export interface ViewportDisplayDefaults {
  meshRenderMode: string;
  meshOpacity: number;
  meshClipEnabled: boolean;
  meshClipAxis: string;
  meshClipPos: number;
  meshShowArrows: boolean;
  airMeshVisible: boolean;
  airMeshOpacity: number;
}

export const VIEWPORT_DISPLAY_DEFAULTS: ViewportDisplayDefaults = {
  meshRenderMode: "surface+edges",
  meshOpacity: 100,
  meshClipEnabled: false,
  meshClipAxis: "x",
  meshClipPos: 50,
  meshShowArrows: false,
  airMeshVisible: !FRONTEND_DIAGNOSTIC_FLAGS.femViewport.airboxDisabledByDefault,
  airMeshOpacity: 28,
};

export interface ResetViewportDisplayResult {
  /** Updated per-part view state map. */
  meshEntityViewState: MeshEntityViewStateMap;
  /** Whether global defaults should also be reset. */
  resetGlobals: boolean;
  /** Global defaults to apply (only meaningful when resetGlobals is true). */
  globals: ViewportDisplayDefaults;
}

export function visualizationPatchForViewportDisplayDefaults(
  defaults: ViewportDisplayDefaults = VIEWPORT_DISPLAY_DEFAULTS,
): VisualizationStatePatch {
  const opacity = Math.max(0, Math.min(100, defaults.meshOpacity)) / 100;
  const airboxOpacity = Math.max(0, Math.min(100, defaults.airMeshOpacity)) / 100;
  return {
    layers: {
      surface: {
        visible: defaults.meshRenderMode === "surface" || defaults.meshRenderMode === "surface+edges",
        opacity,
      },
      quantity_overlay: {
        opacity,
        visible: true,
      },
      wireframe: {
        visible: defaults.meshRenderMode === "wireframe" || defaults.meshRenderMode === "surface+edges",
      },
      volume_mesh: {
        visible: defaults.meshRenderMode === "mesh",
      },
      points: {
        visible: defaults.meshRenderMode === "points",
      },
      vectors: {
        visible: defaults.meshShowArrows,
      },
      primitives: {
        visible: true,
      },
      airbox: {
        visible: defaults.airMeshVisible,
        opacity: airboxOpacity,
      },
    },
    fem: {
      topology_mode:
        defaults.meshRenderMode === "mesh"
          ? "volume"
          : defaults.meshRenderMode === "wireframe" || defaults.meshRenderMode === "surface+edges"
            ? "boundary"
            : "surface",
    },
    clip: {
      enabled: defaults.meshClipEnabled,
      axis:
        defaults.meshClipAxis === "y" || defaults.meshClipAxis === "z"
          ? defaults.meshClipAxis
          : "x",
      position_percent: defaults.meshClipPos,
      flipped: false,
    },
  };
}

/* ── Reset ──────────────────────────────────────────────────────── */

/**
 * Build the reset patch for viewport display state.
 *
 * When scope is "universe", resets ALL per-part state and global defaults.
 * When scope is scoped (object/part/airbox), only resets the targeted
 * parts' per-part state — global defaults are left untouched.
 */
export function buildViewportDisplayReset(
  scope: ViewportSelectionScope,
  meshParts: readonly FemMeshPart[],
  currentViewState: MeshEntityViewStateMap,
  allVisiblePartIds: string[],
): ResetViewportDisplayResult {
  const isGlobal = scope.kind === "universe";
  const targetIds = scopeTargetPartIds(scope, allVisiblePartIds);

  const next: MeshEntityViewStateMap = { ...currentViewState };

  if (isGlobal) {
    // Universe scope: reset every part to its role-based default
    for (const part of meshParts) {
      next[part.id] = defaultMeshEntityViewState(part);
    }
  } else {
    // Scoped: reset only targeted parts
    for (const partId of targetIds) {
      const part = meshParts.find((p) => p.id === partId);
      if (part) {
        next[part.id] = defaultMeshEntityViewState(part);
      }
    }
  }

  return {
    meshEntityViewState: next,
    resetGlobals: isGlobal,
    globals: VIEWPORT_DISPLAY_DEFAULTS,
  };
}

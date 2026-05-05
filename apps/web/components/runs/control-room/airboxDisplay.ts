import type {
  AirboxDisplayPatch,
  AirboxDisplayScope,
  ViewportMeshRenderMode,
} from "@/components/shell/ribbon/command-registry";
import {
  bestPresetFromPasses,
  passesFromPreset,
} from "./meshDisplayState";

export interface AirboxDisplayState {
  geometryVisible: boolean;
  surface: boolean;
  wireframe: boolean;
  points: boolean;
  vectorsVisible: boolean;
  /**
   * Derived from the canonical pass state via `bestPresetFromPasses()`.
   * May be `"custom"` when the active passes do not map to any named preset
   * (e.g. surface + points, wireframe + points).
   *
   * The Ribbon uses this to decide whether to show a preset radio or individual
   * pass checkboxes.  The renderer ignores this field when `renderPasses` is
   * also set on the part.
   */
  renderMode: ViewportMeshRenderMode | "custom";
  wireframeScope: AirboxDisplayScope;
  pointsScope: AirboxDisplayScope;
  vectorsScope: AirboxDisplayScope;
}

export function airboxDisplayStateFromRenderMode(
  renderMode: ViewportMeshRenderMode,
): AirboxDisplayState {
  if (renderMode === "mesh") {
    return {
      geometryVisible: true,
      surface: false,
      wireframe: true,
      points: false,
      vectorsVisible: false,
      renderMode: "wireframe",
      wireframeScope: "full",
      pointsScope: "surface",
      vectorsScope: "surface",
    };
  }
  const passes = passesFromPreset(renderMode);
  return {
    geometryVisible: true,
    surface: passes.surface,
    wireframe: passes.surfaceEdges,
    points: passes.points,
    vectorsVisible: false,
    renderMode,
    wireframeScope: "surface",
    pointsScope: "surface",
    vectorsScope: "surface",
  };
}

export function resolveAirboxDisplayState(
  current: AirboxDisplayState,
  patch: AirboxDisplayPatch,
): AirboxDisplayState {
  // When the current renderMode is "custom" (e.g. surface+points), fall back to
  // "surface+edges" for the purpose of computing mode defaults — the canonical
  // pass state (surface/wireframe/points) is read directly from `current` below.
  const canonicalMode: ViewportMeshRenderMode =
    current.renderMode === "custom" ? "surface+edges" : current.renderMode;
  const modeDefaults = airboxDisplayStateFromRenderMode(canonicalMode);
  const normalizedCurrent = {
    ...modeDefaults,
    geometryVisible: current.geometryVisible,
    surface: current.surface,
    wireframe: current.wireframe,
    points: current.points,
    vectorsVisible: current.vectorsVisible,
    wireframeScope:
      current.renderMode === "mesh"
        ? modeDefaults.wireframeScope
        : current.wireframeScope,
    pointsScope: current.pointsScope,
    vectorsScope: current.vectorsScope,
  };
  const base = patch.renderMode
    ? {
        ...normalizedCurrent,
        ...airboxDisplayStateFromRenderMode(patch.renderMode),
      }
    : normalizedCurrent;

  let shaded = base.surface;
  let wireframe = base.wireframe;
  let points = base.points;

  if (typeof patch.points === "boolean") {
    points = patch.points;
  }
  if (typeof patch.shaded === "boolean") {
    shaded = patch.shaded;
  }
  if (typeof patch.wireframe === "boolean") {
    wireframe = patch.wireframe;
  }

  let geometryVisible =
    typeof patch.geometry === "boolean" ? patch.geometry : base.geometryVisible;
  if (patch.geometry === false) {
    shaded = false;
    wireframe = false;
    points = false;
  }
  if (!shaded && !wireframe && !points) {
    geometryVisible = false;
  } else if (
    patch.geometry === true ||
    patch.shaded === true ||
    patch.wireframe === true ||
    patch.points === true ||
    patch.renderMode
  ) {
    geometryVisible = true;
  }

  const renderMode = geometryVisible
    ? bestPresetFromPasses({
        surface: shaded,
        surfaceEdges: wireframe,
        volumeEdges: false,
        points,
      })
    : base.renderMode; // preserve last-known preset when geometry is hidden

  return {
    geometryVisible,
    surface: shaded,
    wireframe,
    points,
    vectorsVisible: base.vectorsVisible,
    renderMode,
    wireframeScope: patch.wireframeScope ?? base.wireframeScope,
    pointsScope: patch.pointsScope ?? base.pointsScope,
    vectorsScope: patch.vectorsScope ?? base.vectorsScope,
  };
}

/**
 * Convenience helper for ribbon handlers that need only the derived preset label.
 * Returns `"custom"` when the resulting passes don't match any named preset.
 */
export function resolveAirboxRenderMode(
  currentMode: ViewportMeshRenderMode,
  patch: AirboxDisplayPatch,
): ViewportMeshRenderMode | "custom" {
  return resolveAirboxDisplayState(
    { ...airboxDisplayStateFromRenderMode(currentMode), geometryVisible: true },
    patch,
  ).renderMode;
}

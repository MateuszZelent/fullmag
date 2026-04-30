/**
 * meshDisplayState — render-pass state as source of truth.
 *
 * `ViewportMeshRenderMode` (the legacy enum) is preserved for Ribbon presets
 * and wire-format compatibility, but it is a _derived_ view, not canonical state.
 *
 * The canonical representation is `MeshPasses`:
 *
 *   interface MeshPasses {
 *     surface:      boolean;   // shaded triangles
 *     surfaceEdges: boolean;   // boundary / silhouette edges
 *     volumeEdges:  boolean;   // tetrahedral interior edges (expensive)
 *     points:       boolean;   // vertex points
 *   }
 *
 * Use `passesFromPreset()` to initialise from a preset, and
 * `bestPresetFromPasses()` to derive the Ribbon label.  When the label is
 * "custom" the Ribbon shows individual checkboxes instead of a single radio.
 *
 * `ResolvedRenderPass` extends a pass with WebGL cost metadata so that callers
 * can apply a byte budget before allocating geometries.
 */

import type { ViewportMeshRenderMode } from "@/components/shell/ribbon/command-registry";

// ── Canonical pass state ───────────────────────────────────────────────────────

/** Independent render passes for a mesh layer. This is the source of truth. */
export interface MeshPasses {
  /** Shaded triangle surface. */
  surface: boolean;
  /** Boundary / silhouette edges (WireframeGeometry, lineSegments). */
  surfaceEdges: boolean;
  /** Tetrahedral interior edges — expensive; disabled by default for large meshes. */
  volumeEdges: boolean;
  /** Vertex points (THREE.Points). */
  points: boolean;
}

// ── Preset ↔ passes conversion ─────────────────────────────────────────────────

const PRESET_MAP: Record<ViewportMeshRenderMode, MeshPasses> = {
  surface: { surface: true, surfaceEdges: false, volumeEdges: false, points: false },
  wireframe: { surface: false, surfaceEdges: true, volumeEdges: false, points: false },
  "surface+edges": { surface: true, surfaceEdges: true, volumeEdges: false, points: false },
  points: { surface: false, surfaceEdges: false, volumeEdges: false, points: true },
  mesh: { surface: false, surfaceEdges: false, volumeEdges: true, points: false },
};

/** Returns the canonical `MeshPasses` for a named preset. */
export function passesFromPreset(preset: ViewportMeshRenderMode): MeshPasses {
  return { ...PRESET_MAP[preset] };
}

/**
 * Returns the best-matching preset name for the given passes, or `"custom"` when
 * no named preset matches exactly.  The Ribbon uses this to decide whether to show
 * a preset radio or individual checkboxes.
 */
export function bestPresetFromPasses(
  passes: MeshPasses,
): ViewportMeshRenderMode | "custom" {
  for (const [preset, candidate] of Object.entries(PRESET_MAP) as [
    ViewportMeshRenderMode,
    MeshPasses,
  ][]) {
    if (
      passes.surface === candidate.surface &&
      passes.surfaceEdges === candidate.surfaceEdges &&
      passes.volumeEdges === candidate.volumeEdges &&
      passes.points === candidate.points
    ) {
      return preset;
    }
  }
  return "custom";
}

// ── ResolvedRenderPass ─────────────────────────────────────────────────────────

/** WebGL resource cost categories. */
export type RenderPassBudgetClass = "cheap" | "normal" | "expensive";

/**
 * A single resolved render pass with cost metadata.
 * Callers consult `estimatedBytes` and `budgetClass` before allocating Three.js
 * geometries, so that a memory budget can degrade or skip a pass.
 */
export interface ResolvedRenderPass {
  /** Stable identifier, e.g. `"surface"`, `"surfaceEdges"`, `"volumeEdges"`, `"points"`. */
  id: string;
  /** Whether this pass is active in the current render plan. */
  visible: boolean;
  /**
   * Estimated GPU byte cost for this pass given current mesh stats.
   * `0` when `visible` is false or when estimation is unavailable.
   */
  estimatedBytes: number;
  /** Budget classification — used for degradation policy. */
  budgetClass: RenderPassBudgetClass;
  /**
   * Fallback mode when the pass exceeds the budget cap.
   * `undefined` means the pass will be disabled without degradation.
   */
  fallback?: "disabled" | "sampled" | "selection-only";
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Returns `true` when all four passes are `false`. */
export function passesAreEmpty(passes: MeshPasses): boolean {
  return !passes.surface && !passes.surfaceEdges && !passes.volumeEdges && !passes.points;
}

/**
 * Merges a partial pass patch onto base passes.
 * Passes not present in the patch are left unchanged.
 */
export function mergePasses(
  base: MeshPasses,
  patch: Partial<MeshPasses>,
): MeshPasses {
  return { ...base, ...patch };
}

// ── Bridge: MeshEntityRenderPassState ↔ MeshPasses ────────────────────────────
//
// `MeshEntityRenderPassState` (session wire format) uses `wireframe` and
// `volumeMesh`, while `MeshPasses` (canonical) uses `surfaceEdges` and
// `volumeEdges`.  These two small helpers convert between them so that callers
// can work in canonical space and write back to the wire format.

/** The minimal subset of MeshEntityRenderPassState needed for bridging. */
export interface LegacyRenderPassState {
  surface: boolean;
  wireframe: boolean;
  volumeMesh?: boolean;
  points: boolean;
}

/** Convert from session wire format → canonical `MeshPasses`. */
export function meshPassesFromLegacyState(passes: LegacyRenderPassState): MeshPasses {
  return {
    surface: passes.surface,
    surfaceEdges: passes.wireframe,
    volumeEdges: passes.volumeMesh ?? false,
    points: passes.points,
  };
}

/** Convert from canonical `MeshPasses` → session wire format. */
export function legacyStateFromMeshPasses(passes: MeshPasses): LegacyRenderPassState {
  return {
    surface: passes.surface,
    wireframe: passes.surfaceEdges,
    volumeMesh: passes.volumeEdges,
    points: passes.points,
  };
}

/**
 * Best-effort `ViewportMeshRenderMode` for a passes set that may not match any
 * named preset (i.e. `bestPresetFromPasses` returns `"custom"`).  Used only for
 * the legacy `renderMode` field on `MeshEntityViewState` when `renderPasses` is
 * also being set — the renderer ignores `renderMode` when `renderPasses` is
 * present.
 *
 * Priority: points is dropped first (it's the "extra" pass); the surface/edge
 * combination is preserved.
 */
export function legacyRenderModeFromPasses(
  passes: MeshPasses,
): ViewportMeshRenderMode {
  const preset = bestPresetFromPasses(passes);
  if (preset !== "custom") return preset;
  // Custom combination — derive closest legacy mode ignoring points.
  if (passes.volumeEdges) return "mesh";
  if (passes.surface && passes.surfaceEdges) return "surface+edges";
  if (passes.surface) return "surface";
  if (passes.surfaceEdges) return "wireframe";
  return "points";
}

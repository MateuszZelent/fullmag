/**
 * Visualization reducer — canonical action/result types for transactional
 * visualization state changes.
 *
 * Rules:
 *  - Every Ribbon handler must emit one of these actions, not call raw ctx setters.
 *  - The reducer returns both the next state AND a precise invalidation map that
 *    callers can use to skip expensive geometry/sampling work.
 *  - Types here are frontend-only; they describe intent, not wire format.
 */

import type { VectorComponent } from "./shared";
import type { ViewportMeshRenderMode } from "@/components/shell/ribbon/command-registry";
import type { VectorLayerDomain } from "@/src/api/types";

// ── Scopes ────────────────────────────────────────────────────────────────────

export type MeshScope = "global" | "magnetic" | "airbox" | "selection";

// ── Pass state (replaces single `renderMode` enum as source of truth) ─────────

export interface MeshLayerPassState {
  surface: boolean;
  surfaceEdges: boolean;
  volumeEdges: boolean;
  points: boolean;
}

// ── Vector style ──────────────────────────────────────────────────────────────

export interface VectorStyleState {
  alpha: number;
  monoColor: string | null;
  colorMode: "magnitude" | "component" | "mono";
  lengthScale: number;
  thickness: number;
}

// ── Slice state ───────────────────────────────────────────────────────────────

export interface SliceState {
  visible: boolean;
  layer: number;
  mode: string;
  airboxVisible: boolean;
  renderMode: "heatmap" | "vectors";
  /**
   * When true, toggling 2D airbox visibility also patches the 3D render plan.
   * Default false — 2D and 3D airbox are independent unless explicitly linked.
   */
  sync2D3D: boolean;
}

// ── Preset aliases ────────────────────────────────────────────────────────────

export type MeshRenderPreset = ViewportMeshRenderMode;

// ── Action union ──────────────────────────────────────────────────────────────

/**
 * Discriminated union of all Ribbon→Reducer visualization actions.
 * Ribbon handlers emit one of these; the reducer decides what to invalidate.
 */
export type VisualizationAction =
  | { type: "quantity.setShaderVisible"; visible: boolean }
  | { type: "quantity.setComponent"; component: VectorComponent }
  | { type: "mesh.setPreset"; scope: MeshScope; preset: MeshRenderPreset }
  | { type: "mesh.patchPasses"; scope: MeshScope; patch: Partial<MeshLayerPassState> }
  | { type: "airbox.setVisible3D"; visible: boolean }
  | { type: "airbox.setVisible2D"; visible: boolean }
  | { type: "airbox.patch3DPasses"; patch: Partial<MeshLayerPassState> }
  | { type: "vectors.setVisible"; layer: "magnetic" | "airbox" | "slice"; visible: boolean }
  | { type: "vectors.setDomain"; domain: VectorLayerDomain }
  | { type: "vectors.setStyle"; patch: Partial<VectorStyleState> }
  | { type: "slice.patch"; patch: Partial<SliceState> };

// ── Invalidation map ──────────────────────────────────────────────────────────

/**
 * Fine-grained geometry/shader invalidation flags returned alongside state.
 * Consumers use these to skip expensive Three.js work that is not affected by the action.
 *
 * topology        — mesh topology changed; geometries must be rebuilt
 * surfaceGeometry — surface positions/normals changed
 * edgeGeometry    — wireframe/edge buffers changed
 * pointGeometry   — point geometry changed
 * vectorSampling  — vector sample nodes must be recomputed
 * vectorMatrices  — InstancedMesh matrices must be re-uploaded
 * vectorColors    — InstancedMesh color attributes changed only
 * materialOnly    — only material/shader uniforms changed (no geometry rebuild)
 * frameOnly       — only camera/frame changed (no geometry or material work)
 */
export interface VisualizationInvalidation {
  topology: boolean;
  surfaceGeometry: boolean;
  edgeGeometry: boolean;
  pointGeometry: boolean;
  vectorSampling: boolean;
  vectorMatrices: boolean;
  vectorColors: boolean;
  materialOnly: boolean;
  frameOnly: boolean;
}

// ── Transaction result ────────────────────────────────────────────────────────

/**
 * Result of applying a VisualizationAction.
 * Callers receive both the next state and a precise invalidation map.
 */
export interface VisualizationTransactionResult<S> {
  state: S;
  invalidation: VisualizationInvalidation;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clean invalidation — nothing changed; use as a base for spread-update. */
export const NO_INVALIDATION: VisualizationInvalidation = {
  topology: false,
  surfaceGeometry: false,
  edgeGeometry: false,
  pointGeometry: false,
  vectorSampling: false,
  vectorMatrices: false,
  vectorColors: false,
  materialOnly: false,
  frameOnly: false,
};

/** Full invalidation — force all downstream work. */
export const FULL_INVALIDATION: VisualizationInvalidation = {
  topology: true,
  surfaceGeometry: true,
  edgeGeometry: true,
  pointGeometry: true,
  vectorSampling: true,
  vectorMatrices: true,
  vectorColors: true,
  materialOnly: true,
  frameOnly: true,
};

/** Derive invalidation for a mesh-pass patch (no topology change). */
export function invalidationForPassPatch(
  before: Partial<MeshLayerPassState>,
  after: Partial<MeshLayerPassState>,
): VisualizationInvalidation {
  return {
    ...NO_INVALIDATION,
    surfaceGeometry: before.surface !== after.surface,
    edgeGeometry:
      before.surfaceEdges !== after.surfaceEdges ||
      before.volumeEdges !== after.volumeEdges,
    pointGeometry: before.points !== after.points,
    materialOnly: false,
  };
}

// ── Reducer ───────────────────────────────────────────────────────────────────

/**
 * Pure reducer for `SliceState` visualization actions.
 *
 * Only handles actions that are scoped to the 2D slice plane.
 * 3D-only actions (airbox.setVisible3D, airbox.patch3DPasses, mesh.*,
 * vectors.*, quantity.*) are handled by their respective 3D-state owners.
 *
 * Callers use the returned `invalidation` to skip 3D geometry work when
 * only the 2D slice state changed (e.g. airbox.setVisible2D → NO_INVALIDATION
 * on all 3D geometry flags).
 */
export function applyVisualizationAction(
  state: SliceState,
  action: VisualizationAction,
): VisualizationTransactionResult<SliceState> {
  switch (action.type) {
    case "airbox.setVisible2D":
      return {
        state: { ...state, airboxVisible: action.visible },
        // 2D-only toggle: no 3D geometry/material change
        invalidation: NO_INVALIDATION,
      };
    case "slice.patch":
      return {
        state: { ...state, ...action.patch },
        invalidation: NO_INVALIDATION,
      };
    default:
      // Actions not scoped to SliceState: no state change, no invalidation.
      return { state, invalidation: NO_INVALIDATION };
  }
}

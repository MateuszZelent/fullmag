/**
 * Layer D – FEM Viewport Engine: Arrow Visibility Model
 *
 * Replaces the bare boolean `femShouldShowArrows` with a structured
 * contract: { requested, visible, reason }.  Consumers can now show
 * a tooltip or status chip explaining *why* arrows are hidden.
 */

import type { FRONTEND_DIAGNOSTIC_FLAGS } from "../../../lib/debug/frontendDiagnosticFlags";

/* ── Types ──────────────────────────────────────────────────────── */

export type ArrowHiddenReason =
  | "not_fem_backend"
  | "not_3d_view"
  | "no_field_data"
  | "user_disabled"
  | "diagnostic_force_hidden";

export interface ArrowVisibilityStatus {
  /** User's current toggle state (meshShowArrows). */
  requested: boolean;
  /** Actual runtime visibility after all gates. */
  visible: boolean;
  /** `null` when visible; explains why arrows are hidden otherwise. */
  reason: ArrowHiddenReason | null;
}

/* ── Resolver ───────────────────────────────────────────────────── */

export interface ResolveArrowVisibilityInput {
  isFemBackend: boolean;
  effectiveViewMode: string; // "3D" | "2D" | "Mesh" etc.
  femHasFieldData: boolean;
  meshShowArrows: boolean;
  diagnosticForceHideArrows: boolean;
}

/**
 * Pure function that resolves the arrow visibility status.
 *
 * Gate priority (first failing gate wins):
 * 1. diagnostic `forceHideArrows` flag
 * 2. not FEM backend
 * 3. not 3D view mode
 * 4. no field data loaded
 * 5. user toggle disabled
 */
export function resolveArrowVisibility(
  input: ResolveArrowVisibilityInput,
): ArrowVisibilityStatus {
  const {
    isFemBackend,
    effectiveViewMode,
    femHasFieldData,
    meshShowArrows,
    diagnosticForceHideArrows,
  } = input;

  if (diagnosticForceHideArrows) {
    return { requested: meshShowArrows, visible: false, reason: "diagnostic_force_hidden" };
  }
  if (!isFemBackend) {
    return { requested: meshShowArrows, visible: false, reason: "not_fem_backend" };
  }
  if (effectiveViewMode !== "3D") {
    return { requested: meshShowArrows, visible: false, reason: "not_3d_view" };
  }
  if (!femHasFieldData) {
    return { requested: meshShowArrows, visible: false, reason: "no_field_data" };
  }
  if (!meshShowArrows) {
    return { requested: false, visible: false, reason: "user_disabled" };
  }
  return { requested: true, visible: true, reason: null };
}

/**
 * @module lib/quantities/compat
 *
 * Legacy compatibility layer (QB-18).
 *
 * Bridges the old `LiveState` flat-field model and hardcoded column
 * names to the new catalog-driven quantity system.  These helpers
 * exist solely to keep old code working during the transition period
 * and MUST be removed once all consumers migrate to catalog-based
 * access.
 *
 * @deprecated — all functions in this module are transitional
 */

import type { QuantityId } from "./types";
import { quantityById } from "./catalog";

// ── Legacy scalar metric key → QuantityId ────────────────────────

const METRIC_KEY_TO_QID: Record<string, QuantityId> = {
  e_ex: "E_ex",
  e_demag: "E_demag",
  e_ext: "E_ext",
  e_ani: "E_ani",
  e_dmi: "E_dmi",
  e_total: "E_total",
};

/**
 * Map a legacy `StepStats` / `LiveState` scalar key (e.g. `"e_ex"`)
 * to the canonical `QuantityId`.
 *
 * @deprecated Use catalog-driven lookup instead
 */
export function metricKeyToQuantityId(key: string): QuantityId | undefined {
  return METRIC_KEY_TO_QID[key];
}

// ── Legacy column label table ────────────────────────────────────

/**
 * Build the `COLUMN_LABELS` record from the catalog so chart code
 * can drop its hardcoded copy.
 *
 * Returns e.g. `{ e_ex: "Exchange Energy (J)", ... }`
 *
 * @deprecated Consumers should call `quantityColumnLabel()` directly
 */
export function buildLegacyColumnLabels(): Record<string, string> {
  const labels: Record<string, string> = {};

  // Physical scalars from catalog
  for (const [key, qid] of Object.entries(METRIC_KEY_TO_QID)) {
    const desc = quantityById(qid);
    if (desc) {
      labels[key] =
        desc.unit && desc.unit !== "dimensionless"
          ? `${desc.label} (${desc.unit})`
          : desc.label;
    }
  }

  // Solver diagnostics (not in quantity catalog — hardcoded here on purpose)
  labels["step"] = "Step";
  labels["time"] = "Time (s)";
  labels["solver_dt"] = "Δt (s)";
  labels["mx"] = "m_x avg";
  labels["my"] = "m_y avg";
  labels["mz"] = "m_z avg";
  labels["max_dm_dt"] = "max dm/dt (rad/s)";
  labels["max_h_eff"] = "max |H_eff| (A/m)";
  labels["max_h_demag"] = "max |H_demag| (A/m)";

  return labels;
}

// ── Legacy preview field id → QuantityId ─────────────────────────

const PREVIEW_ALIAS_TO_QID: Record<string, QuantityId> = {
  magnetization: "m",
  exchange: "H_ex",
  demag: "H_demag",
  external: "H_ext",
  antenna: "H_ant",
  effective: "H_eff",
  anisotropy: "H_ani",
  dmi: "H_dmi",
};

/**
 * Map a legacy preview-field alias (e.g. `"magnetization"`, `"exchange"`)
 * to the canonical `QuantityId`.
 *
 * @deprecated Use `QuantityId` directly
 */
export function previewAliasToQuantityId(alias: string): QuantityId | undefined {
  return PREVIEW_ALIAS_TO_QID[alias];
}

/**
 * @module lib/quantities/catalog
 *
 * Static quantity catalog mirroring the Rust `QUANTITY_SPECS` table from
 * `crates/fullmag-runner/src/quantities.rs`.
 *
 * This is a **transitional** static catalog.  When QB-13 lands the
 * `GET /api/quantities/catalog` endpoint, this file will be replaced
 * by a runtime fetch + cache.  Until then it is the single frontend
 * source of truth (ZP-01), kept 1:1 with the Rust table.
 *
 * DO NOT add quantity entries here that do not exist in the Rust
 * `QUANTITY_SPECS` array.  If you need a new quantity, add it to the
 * Rust crate first.
 */

import type { QuantityDescriptor, QuantityId, QuantityShape } from "./types";

// ── Static catalog ───────────────────────────────────────────────

const CATALOG: readonly QuantityDescriptor[] = [
  // ─── Vector fields ──────────────────────────────────────────
  {
    id: "m",
    label: "Magnetization",
    shape: "vector_field",
    unit: "dimensionless",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "unit_vector",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "M",
  },
  {
    id: "H_ex",
    label: "Exchange Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_ex",
  },
  {
    id: "H_demag",
    label: "Demagnetization Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "full_domain",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_demag",
  },
  {
    id: "H_ext",
    label: "External Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "full_domain",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_ext",
  },
  {
    id: "H_ant",
    label: "Antenna Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "full_domain",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_ant",
  },
  {
    id: "H_eff",
    label: "Effective Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "full_domain",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_eff",
  },
  {
    id: "H_ani",
    label: "Anisotropy Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_ani",
  },
  {
    id: "H_dmi",
    label: "DMI Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_dmi",
  },
  {
    id: "H_mel",
    label: "Magnetoelastic Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_mel",
  },
  {
    id: "H_ani_cubic",
    label: "Cubic Anisotropy Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_ani_cubic",
  },
  {
    id: "H_dmi_bulk",
    label: "Bulk DMI Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_dmi_bulk",
  },
  {
    id: "H_oe",
    label: "Oersted Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "full_domain",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_oe",
  },
  {
    id: "H_therm",
    label: "Thermal Noise Field",
    shape: "vector_field",
    unit: "A/m",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: true,
    supportsPreview2d: true,
    supportsPreview3d: true,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: true,
    quickAccessLabel: "H_therm",
  },

  // ─── Global scalars ─────────────────────────────────────────
  {
    id: "E_ex",
    label: "Exchange Energy",
    shape: "global_scalar",
    unit: "J",
    nComp: 1,
    location: "global",
    domain: "magnetic_only",
    normalizationHint: "none",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: true,
    supportsExport: true,
    uiExposed: true,
    scalarMetricKey: "e_ex",
  },
  {
    id: "E_demag",
    label: "Demagnetization Energy",
    shape: "global_scalar",
    unit: "J",
    nComp: 1,
    location: "global",
    domain: "magnetic_only",
    normalizationHint: "none",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: true,
    supportsExport: true,
    uiExposed: true,
    scalarMetricKey: "e_demag",
  },
  {
    id: "E_ext",
    label: "External Energy",
    shape: "global_scalar",
    unit: "J",
    nComp: 1,
    location: "global",
    domain: "full_domain",
    normalizationHint: "none",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: true,
    supportsExport: true,
    uiExposed: true,
    scalarMetricKey: "e_ext",
  },
  {
    id: "E_ani",
    label: "Anisotropy Energy",
    shape: "global_scalar",
    unit: "J",
    nComp: 1,
    location: "global",
    domain: "magnetic_only",
    normalizationHint: "none",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: true,
    supportsExport: true,
    uiExposed: true,
    scalarMetricKey: "e_ani",
  },
  {
    id: "E_dmi",
    label: "DMI Energy",
    shape: "global_scalar",
    unit: "J",
    nComp: 1,
    location: "global",
    domain: "magnetic_only",
    normalizationHint: "none",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: true,
    supportsExport: true,
    uiExposed: true,
    scalarMetricKey: "e_dmi",
  },
  {
    id: "E_total",
    label: "Total Energy",
    shape: "global_scalar",
    unit: "J",
    nComp: 1,
    location: "global",
    domain: "full_domain",
    normalizationHint: "none",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: true,
    supportsExport: true,
    uiExposed: true,
    scalarMetricKey: "e_total",
  },

  // ─── Mode data (internal, not exposed in public UI) ─────────
  {
    id: "mode_amplitude",
    label: "Mode Amplitude",
    shape: "spatial_scalar",
    unit: "dimensionless",
    nComp: 1,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: false,
  },
  {
    id: "mode_real",
    label: "Mode Real Part",
    shape: "vector_field",
    unit: "dimensionless",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: false,
  },
  {
    id: "mode_imag",
    label: "Mode Imaginary Part",
    shape: "vector_field",
    unit: "dimensionless",
    nComp: 3,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "max_abs",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: false,
  },
  {
    id: "mode_phase",
    label: "Mode Phase",
    shape: "spatial_scalar",
    unit: "rad",
    nComp: 1,
    location: "node",
    domain: "magnetic_only",
    normalizationHint: "none",
    interactivePreview: false,
    supportsPreview2d: false,
    supportsPreview3d: false,
    supportsHistory: false,
    supportsExport: true,
    uiExposed: false,
  },
] as const;

// ── Lookup helpers ───────────────────────────────────────────────

const BY_ID = new Map<QuantityId, QuantityDescriptor>(
  CATALOG.map((d) => [d.id, d]),
);

/** Return the full catalog (all 23 backend quantities). */
export function quantityCatalog(): readonly QuantityDescriptor[] {
  return CATALOG;
}

/** Lookup a single descriptor by canonical id. */
export function quantityById(id: QuantityId): QuantityDescriptor | undefined {
  return BY_ID.get(id);
}

/** All quantities exposed in the public UI. */
export function uiExposedQuantities(): QuantityDescriptor[] {
  return CATALOG.filter((d) => d.uiExposed);
}

/** All quantities supporting interactive preview. */
export function interactivePreviewQuantities(): QuantityDescriptor[] {
  return CATALOG.filter((d) => d.uiExposed && d.interactivePreview);
}

/** All quantities supporting history (time-series charts). */
export function historyQuantities(): QuantityDescriptor[] {
  return CATALOG.filter((d) => d.uiExposed && d.supportsHistory);
}

/** Filter quantities by shape. */
export function quantitiesByShape(shape: QuantityShape): QuantityDescriptor[] {
  return CATALOG.filter((d) => d.uiExposed && d.shape === shape);
}

/** All quantity IDs known to the catalog. */
export function allQuantityIds(): QuantityId[] {
  return CATALOG.map((d) => d.id);
}

/**
 * Get column label for history/chart display.
 * Driven purely by the catalog — no hardcoded fallback tables.
 */
export function quantityColumnLabel(id: QuantityId): string {
  const d = BY_ID.get(id);
  if (!d) return id;
  return d.unit && d.unit !== "dimensionless"
    ? `${d.label} (${d.unit})`
    : d.label;
}

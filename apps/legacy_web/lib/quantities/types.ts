/**
 * @module lib/quantities/types
 *
 * Canonical TypeScript mirroring of the Rust `fullmag-runner/src/quantities.rs`
 * contract.  These types are the **single frontend source of truth** for
 * quantity identity, shape, domain, location, and rendering hints.
 *
 * When the backend-first `fullmag-quantities` crate lands (QB-02), these types
 * will be auto-generated or validated against the Rust schema.  Until then they
 * are maintained manually but must stay 1:1 with the Rust definitions.
 *
 * Design principles (from masterplan §5):
 *   ZP-01 — no parallel catalogs
 *   ZP-02 — `m` is not an exception
 *   ZP-03 — separate physics from solver diagnostics
 *   ZP-04 — all outputs share common contract
 *   ZP-05 — UI never guesses quantity metadata
 */

// ── Quantity identity ────────────────────────────────────────────

/**
 * Canonical quantity IDs mirroring `QuantityId` in Rust.
 * Snake_case strings match the serde serialization.
 */
export type QuantityId =
  | "m"
  | "H_ex"
  | "H_demag"
  | "H_ext"
  | "H_ant"
  | "H_eff"
  | "torque"
  | "H_ani"
  | "H_dmi"
  | "H_mel"
  | "H_ani_cubic"
  | "H_dmi_bulk"
  | "H_oe"
  | "H_therm"
  | "E_ex"
  | "E_demag"
  | "E_ext"
  | "E_ani"
  | "E_dmi"
  | "E_total"
  | "mode_amplitude"
  | "mode_real"
  | "mode_imag"
  | "mode_phase"
  // ── Second wave (QB-17): energy densities, torques, dm/dt ──
  | "eden_ex"
  | "eden_demag"
  | "eden_ext"
  | "eden_ani"
  | "eden_dmi"
  | "eden_total"
  | "dm_dt"
  | "torque_stt"
  | "torque_sot";

// ── Shape / Kind ─────────────────────────────────────────────────

/** Mirrors `QuantityKind` in Rust. */
export type QuantityShape = "vector_field" | "spatial_scalar" | "global_scalar";

// ── Domain & Location ────────────────────────────────────────────

/** Where the quantity is spatially located on the mesh. */
export type QuantityLocation = "node" | "cell" | "global";

/** Physical domain the quantity occupies. */
export type QuantityDomain = "magnetic_only" | "full_domain";

// ── Component selection ──────────────────────────────────────────

export type QuantityComponent = "3D" | "x" | "y" | "z" | "magnitude";

// ── Normalization ────────────────────────────────────────────────

export type NormalizationHint = "unit_vector" | "max_abs" | "none";

// ── Reduction (QB-06 prep) ───────────────────────────────────────

export type QuantityReduction =
  | "none"
  | "average"
  | "sum"
  | "integral"
  | "min"
  | "max"
  | "magnitude";

// ── Descriptor ───────────────────────────────────────────────────

/**
 * Full descriptor for a single quantity — the TypeScript analog of
 * `QuantitySpec` in Rust.  Carries everything the UI needs to render
 * a picker, legend, chart column, or preview without local guessing.
 */
export interface QuantityDescriptor {
  /** Canonical string id (e.g. `"m"`, `"H_ex"`, `"E_total"`). */
  id: QuantityId;
  /** Human-readable label (e.g. `"Exchange Field"`). */
  label: string;
  /** Shape determines renderer: arrows, heatmap, scalar card. */
  shape: QuantityShape;
  /** SI unit string (e.g. `"A/m"`, `"J"`, `"dimensionless"`). */
  unit: string;
  /** Number of components (3 for vector, 1 for scalar). */
  nComp: number;
  /** Where the quantity lives on the mesh. */
  location: QuantityLocation;
  /** Physical domain. */
  domain: QuantityDomain;
  /** UI normalization strategy. */
  normalizationHint: NormalizationHint;

  // ── Capability flags ─────────────────────────────────────────
  /** Supports interactive (live) preview switching. */
  interactivePreview: boolean;
  /** Supports 2D scalar-field slice preview. */
  supportsPreview2d: boolean;
  /** Supports 3D volumetric/arrow preview. */
  supportsPreview3d: boolean;
  /** Can appear in time-series history charts. */
  supportsHistory: boolean;
  /** Can be exported to VTK / HDF5. */
  supportsExport: boolean;
  /** Exposed in the public UI (false = internal / mode data). */
  uiExposed: boolean;

  // ── UI helpers ───────────────────────────────────────────────
  /** Short label for ribbon quick-access buttons (e.g. `"M"`, `"H_ex"`). */
  quickAccessLabel?: string;
  /** Legacy key mapping into StepStats for global scalars. */
  scalarMetricKey?: string;
}

// ── Solver diagnostics (ZP-03) ───────────────────────────────────

/**
 * Solver diagnostics are NOT physical quantities.
 * They travel in `StepDiagnostics`, not in quantity frames.
 */
export interface StepDiagnostics {
  step: number;
  time: number;
  dt: number;
  wallTimeNs: number;
  exchangeWallTimeNs: number;
  demagWallTimeNs: number;
  rhsWallTimeNs: number;
  extraEnergyWallTimeNs: number;
  snapshotWallTimeNs: number;
  errorEstimate: number | null;
  dtSuggested: number | null;
  rejectedAttempts: number;
  rhsEvals: number;
  demagSolves: number;
  fsalReused: boolean;
}

// ── Live quantity frame (QB-08 / QB-09 prep) ─────────────────────

/**
 * A single quantity snapshot in the live stream.
 * Replaces the special-cased `magnetization` and `preview_field` fields.
 */
export interface LiveQuantityFrame {
  quantityId: QuantityId;
  shape: QuantityShape;
  nComp: number;
  unit: string;
  /** Grid dimensions [nx, ny, nz] for FDM or mesh ref for FEM. */
  grid: [number, number, number] | null;
  /** Binary data — Float64Array for vector fields, Float64Array for scalars. */
  data: Float64Array | null;
}

// ── Quantity request (QB-10 / QB-12 prep) ────────────────────────

/** Where a quantity value should be delivered. */
export type QuantitySink =
  | "live_preview"
  | "snapshot_artifact"
  | "table_row"
  | "python_pull"
  | "api_stream";

/**
 * A request to output a quantity — the TypeScript analog of
 * `QuantityOutputIR` described in masterplan §10.2.
 */
export interface QuantityRequest {
  quantityId: QuantityId;
  component?: QuantityComponent;
  reduction?: QuantityReduction;
  sink: QuantitySink;
  cadenceSeconds?: number;
}

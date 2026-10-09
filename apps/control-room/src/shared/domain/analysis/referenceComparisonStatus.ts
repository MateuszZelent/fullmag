/**
 * Comparison status of a dispersion reference (ADR 0054, spec 32 §9).
 *
 * The status is derived from published metadata only. Agreement between the
 * curves never produces "matching": that requires the run to declare the same
 * physical assumptions as the reference model.
 */
export type ReferenceComparisonStatus =
  | "matching"
  | "different_assumptions"
  | "assumptions_not_recorded"
  | "outside_validity_range"
  | "branch_unconfirmed"
  | "no_data";

export interface ReferenceComparisonInput {
  /** Reference values are present for the computed samples. */
  hasReferencePoints: boolean;
  /** Assumptions declared by the run, when published (e.g. "open_film", "finite_dirichlet_airbox"). */
  runBoundaryAssumption: string | null;
  /** Assumption of the reference model, e.g. "open_film" for Kalinikos–Slavin n=0. */
  referenceBoundaryAssumption: string | null;
  /** Largest |k| on the computed path [rad/m]. */
  maxPathWavevectorRadPerM: number | null;
  /** Validity limit declared by the validation intent [rad/m]. */
  validityMaxWavevectorRadPerM: number | null;
  /** Branches were assigned by modal overlap rather than frequency order. */
  branchTrackingConfirmed: boolean;
}

export interface ReferenceComparisonResult {
  reasons: string[];
  status: ReferenceComparisonStatus;
}

const ANALYTIC_MODEL_ASSUMPTIONS: Readonly<Record<string, string>> = {
  kalinikos_slab_n0: "open_film",
  kalinikos_slavin_n0: "open_film",
};

export function referenceModelBoundaryAssumption(analyticModel: string | null): string | null {
  return analyticModel ? ANALYTIC_MODEL_ASSUMPTIONS[analyticModel] ?? null : null;
}

/**
 * Boundary assumption of a run from its published magnetostatic boundary
 * condition (`requested_execution.magnetostatic_bc`). Airbox truncations are
 * finite domains and never equal an open-film reference.
 */
const MAGNETOSTATIC_BC_ASSUMPTIONS: Readonly<Record<string, string>> = {
  open: "open_film",
  floquet_airbox: "finite_floquet_airbox",
  periodic_airbox_k0: "finite_periodic_airbox",
};

export function runBoundaryAssumptionFromMagnetostaticBc(
  magnetostaticBc: string | null,
): string | null {
  return magnetostaticBc ? MAGNETOSTATIC_BC_ASSUMPTIONS[magnetostaticBc] ?? null : null;
}

export function referenceComparisonStatus(input: ReferenceComparisonInput): ReferenceComparisonResult {
  if (!input.hasReferencePoints) {
    return { reasons: ["No reference values are published for these samples."], status: "no_data" };
  }
  if (
    input.validityMaxWavevectorRadPerM != null &&
    input.maxPathWavevectorRadPerM != null &&
    input.maxPathWavevectorRadPerM > input.validityMaxWavevectorRadPerM
  ) {
    return {
      reasons: ["The k path extends beyond the reference's declared validity range."],
      status: "outside_validity_range",
    };
  }
  if (!input.runBoundaryAssumption || !input.referenceBoundaryAssumption) {
    return {
      reasons: ["The run or the reference does not publish its boundary assumptions; agreement is not validation."],
      status: "assumptions_not_recorded",
    };
  }
  if (input.runBoundaryAssumption !== input.referenceBoundaryAssumption) {
    return {
      reasons: [
        `The run assumes ${input.runBoundaryAssumption}; the reference assumes ${input.referenceBoundaryAssumption}.`,
      ],
      status: "different_assumptions",
    };
  }
  if (!input.branchTrackingConfirmed) {
    return {
      reasons: ["Modes are assigned to branches by frequency order only; per-branch deviation is not established."],
      status: "branch_unconfirmed",
    };
  }
  return { reasons: ["Run and reference declare the same assumptions."], status: "matching" };
}

export const REFERENCE_COMPARISON_LABELS: Readonly<Record<ReferenceComparisonStatus, string>> = {
  assumptions_not_recorded: "Assumptions not recorded",
  branch_unconfirmed: "Branch unconfirmed",
  different_assumptions: "Different assumptions",
  matching: "Matching assumptions",
  no_data: "No reference data",
  outside_validity_range: "Outside validity range",
};

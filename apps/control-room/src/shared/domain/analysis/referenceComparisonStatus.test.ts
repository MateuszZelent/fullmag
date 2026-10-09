import { describe, expect, it } from "vitest";

import {
  referenceComparisonStatus,
  referenceModelBoundaryAssumption,
  runBoundaryAssumptionFromMagnetostaticBc,
} from "./referenceComparisonStatus";

const base = {
  branchTrackingConfirmed: true,
  hasReferencePoints: true,
  maxPathWavevectorRadPerM: 25e6,
  referenceBoundaryAssumption: "open_film",
  runBoundaryAssumption: "open_film",
  validityMaxWavevectorRadPerM: 30e6,
};

describe("reference comparison status", () => {
  it("is matching only when both sides declare the same assumptions", () => {
    expect(referenceComparisonStatus(base).status).toBe("matching");
    expect(referenceComparisonStatus({ ...base, runBoundaryAssumption: null }).status).toBe("assumptions_not_recorded");
  });

  it("separates a finite Dirichlet airbox run from an open-film reference", () => {
    expect(
      referenceComparisonStatus({ ...base, runBoundaryAssumption: "finite_dirichlet_airbox" }).status,
    ).toBe("different_assumptions");
  });

  it("reports missing data, validity range and unconfirmed branches", () => {
    expect(referenceComparisonStatus({ ...base, hasReferencePoints: false }).status).toBe("no_data");
    expect(referenceComparisonStatus({ ...base, maxPathWavevectorRadPerM: 40e6 }).status).toBe("outside_validity_range");
    expect(referenceComparisonStatus({ ...base, branchTrackingConfirmed: false }).status).toBe("branch_unconfirmed");
  });

  it("maps the published analytic model to its assumption", () => {
    expect(referenceModelBoundaryAssumption("kalinikos_slab_n0")).toBe("open_film");
    expect(referenceModelBoundaryAssumption("unknown")).toBeNull();
  });

  it("derives the run assumption from the published magnetostatic boundary", () => {
    expect(runBoundaryAssumptionFromMagnetostaticBc("open")).toBe("open_film");
    expect(runBoundaryAssumptionFromMagnetostaticBc("floquet_airbox")).toBe("finite_floquet_airbox");
    expect(runBoundaryAssumptionFromMagnetostaticBc("not_applicable")).toBeNull();
  });
});

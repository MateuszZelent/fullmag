import { describe, expect, it } from "vitest";

import type { EigenDispersionPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

import {
  buildEigenDispersionPointViewModel,
  dispersionReferenceComparison,
} from "./EigenDispersionInspectorModel";

const point: EigenDispersionPoint = {
  analyticFrequencyHz: 12.45e9,
  branchId: "acoustic",
  frequencyHz: 12.5e9,
  linewidthHz: 24e6,
  modeFieldId: "analysis:eigen:sample-0004:mode-0005",
  modeFieldResourceKey: "field://mode-0005",
  overlap: 0.98,
  pathS: 78_539_816.33974482,
  rawModeIndex: 5,
  relativeError: 0.004,
  residualNorm: 1e-6,
  sampleLabel: "X",
  sampleIndex: 4,
  validationGeometry: "backward_volume",
};

describe("EigenDispersionInspectorPanel point model", () => {
  it("keeps path coordinate in rad/m while frequency and linewidth stay in Hz", () => {
    expect(buildEigenDispersionPointViewModel(point)).toEqual({
      branchId: "acoustic",
      fieldAvailable: true,
      frequencyHz: 12.5e9,
      kLabel: "X",
      linewidthHz: 24e6,
      pathCoordinate: 78_539_816.33974482,
      pathUnit: "rad/m",
      pointId: "results:eigen:dispersion:sample:4:mode:5",
    });
  });

  it(
    "uses per-sample wavevector norms rather than cumulative path span for validity",
    uses_wavevector_norm_not_cumulative_path_span_for_validity,
  );

  it(
    "leaves the declared k range unverified when per-sample vector coverage is incomplete or invalid",
    leaves_declared_k_range_unverified_without_complete_finite_wavevectors,
  );
});

function uses_wavevector_norm_not_cumulative_path_span_for_validity() {
  const manifest = {
    requested_execution: { boundary_assumption: "open_film" },
    validation: {
      dispersion_validation: {
        analytic_model: "kalinikos_slab_n0",
        max_k_rad_per_m: 30e6,
      },
    },
  };
  const diagnostics = { tracking_score_source: "modal_overlap_mass_weighted" };
  const signedPath = [
    dispersionPoint([-25e6, 0, 0], 0, 0),
    dispersionPoint([0, 0, 0], 25e6, 1),
    dispersionPoint([25e6, 0, 0], 50e6, 2),
  ];

  expect(
    dispersionReferenceComparison(manifest, signedPath, diagnostics, []).status,
  ).toBe("matching");
  const gammaOnlyManifest = {
    ...manifest,
    validation: {
      dispersion_validation: {
        analytic_model: "kalinikos_slab_n0",
        max_k_rad_per_m: 0,
      },
    },
  };
  expect(
    dispersionReferenceComparison(
      gammaOnlyManifest,
      [dispersionPoint([0, 0, 0], 50e6, 0)],
      diagnostics,
      [],
    ).status,
  ).toBe("matching");
  expect(
    dispersionReferenceComparison(
      manifest,
      [dispersionPoint([0, 0, 25e6], 500e6, 0)],
      diagnostics,
      [],
    ).status,
  ).toBe("matching");
  expect(
    dispersionReferenceComparison(
      manifest,
      [dispersionPoint([22e6, 22e6, 0], 0, 0)],
      diagnostics,
      [],
    ).status,
  ).toBe("outside_validity_range");
}

function leaves_declared_k_range_unverified_without_complete_finite_wavevectors() {
  const manifest = {
    requested_execution: { boundary_assumption: "open_film" },
    validation: {
      dispersion_validation: {
        analytic_model: "kalinikos_slab_n0",
        max_k_rad_per_m: 30e6,
      },
    },
  };
  const diagnostics = { tracking_score_source: "modal_overlap_mass_weighted" };
  const invalidCoverage = [
    [dispersionPoint([0, 0, 0], 0, 0), dispersionPoint(null, 50e6, 1)],
    [dispersionPoint([Number.NaN, 0, 0], 0, 0)],
    [dispersionPoint([Number.POSITIVE_INFINITY, 0, 0], 0, 0)],
    [dispersionPoint([Number.MAX_VALUE, Number.MAX_VALUE, 0], 0, 0)],
  ];

  for (const points of invalidCoverage) {
    const comparison = dispersionReferenceComparison(
      manifest,
      points,
      diagnostics,
      [],
    );
    expect(comparison.status).toBe("assumptions_not_recorded");
    expect(comparison.reasons.join(" ")).toContain(
      "cumulative path coordinate is not a substitute",
    );
  }

  const differentAssumptions = dispersionReferenceComparison(
    {
      ...manifest,
      requested_execution: { boundary_assumption: "finite_dirichlet_airbox" },
    },
    [dispersionPoint(null, 50e6, 0)],
    diagnostics,
    [],
  );
  expect(differentAssumptions.status).toBe("different_assumptions");
  expect(differentAssumptions.reasons.join(" ")).toContain(
    "cumulative path coordinate is not a substitute",
  );

  const untracked = dispersionReferenceComparison(
    manifest,
    [dispersionPoint(null, 50e6, 0)],
    { tracking_score_source: "frequency_order" },
    [],
  );
  expect(untracked.status).toBe("branch_unconfirmed");
  expect(untracked.reasons.join(" ")).toContain(
    "cumulative path coordinate is not a substitute",
  );

  const noReferencePoints = dispersionReferenceComparison(
    manifest,
    [{ ...dispersionPoint(null, 50e6, 0), analyticFrequencyHz: null }],
    diagnostics,
    [],
  );
  expect(noReferencePoints.status).toBe("no_data");
  expect(noReferencePoints.reasons.join(" ")).toContain(
    "cumulative path coordinate is not a substitute",
  );

  const noPathPoints = dispersionReferenceComparison(
    manifest,
    [],
    diagnostics,
    [],
  );
  expect(noPathPoints.status).toBe("no_data");
  expect(noPathPoints.reasons.join(" ")).toContain(
    "cumulative path coordinate is not a substitute",
  );
}

function dispersionPoint(
  wavevectorKf: EigenDispersionPoint["wavevectorKf"],
  pathS: number,
  sampleIndex: number,
): EigenDispersionPoint {
  return { ...point, pathS, sampleIndex, wavevectorKf };
}

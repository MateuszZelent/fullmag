import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
} from "@/kernel/api/apiPaths";

import { resolveFrequencyDomainNodeDetail } from "./frequencyDomainNodeDetails";

const RESULTS_NAVIGATOR_DETAILS = [
  [
    "results.frequency_domain.fmr_resonance_fit",
    "FMR Resonance Fit",
    ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
  ],
  [
    "results.eigen.field_sweep",
    "Eigen Field Sweep",
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH,
  ],
  [
    "results.eigen.samples",
    "Eigen Samples",
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ],
  [
    "results.eigen.sample",
    "Eigen Sample",
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ],
  [
    "results.eigen.mode_metadata",
    "Eigen Mode Metadata",
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ],
  [
    "results.eigen.mode_field",
    "Eigen Mode Field",
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ],
  [
    "results.eigen.mode_residuals",
    "Eigen Mode Residuals",
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ],
] as const;

describe("resolveFrequencyDomainNodeDetail", () => {
  it.each(RESULTS_NAVIGATOR_DETAILS)(
    "maps Results Navigator kind %s to its dedicated detail",
    (kind, title, resource) => {
      const selection: Selection = {
        kind,
        label: title,
        moduleSource: "results-navigator",
        nodeId: `results:${kind}`,
        objectId: null,
        ref: {
          kind,
          nodeId: `results:${kind}`,
          type: "frequency-domain",
        },
      };

      expect(resolveFrequencyDomainNodeDetail(selection)).toMatchObject({
        resource,
        title,
      });
    },
  );
});

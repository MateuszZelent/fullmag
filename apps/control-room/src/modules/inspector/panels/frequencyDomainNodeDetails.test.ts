import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import { resolveFrequencyDomainNodeDetail } from "./frequencyDomainNodeDetails";

const RESULTS_NAVIGATOR_DETAILS = [
  [
    "results.frequency_domain.fmr_resonance_fit",
    "FMR Resonance Fit",
    "/v2/sessions/current/analysis/frequency-domain/fmr/resonance-fits",
  ],
  [
    "results.eigen.field_sweep",
    "Eigen Field Sweep",
    "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep",
  ],
  [
    "results.eigen.samples",
    "Eigen Samples",
    "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
  ],
  [
    "results.eigen.sample",
    "Eigen Sample",
    "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
  ],
  [
    "results.eigen.mode_metadata",
    "Eigen Mode Metadata",
    "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{mode_index}/meta",
  ],
  [
    "results.eigen.mode_field",
    "Eigen Mode Field",
    "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{mode_index}/meta",
  ],
  [
    "results.eigen.mode_residuals",
    "Eigen Mode Residuals",
    "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
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

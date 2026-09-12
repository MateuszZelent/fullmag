import { describe, expect, it } from "vitest";

import {
  ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
  ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
} from "@/kernel/api/apiPaths";

import {
  legacyDsfPointSelectionRef,
  legacyGammaFeatureSelectionRef,
  legacyTimeDomainSelectionPatch,
} from "./legacyTimeDomainSelection";

describe("legacy time-domain selection adapter", () => {
  it("keeps a Gamma peak as a partial stable spectral-feature selection", () => {
    const selection = legacyGammaFeatureSelectionRef(
      {
        frequencyHz: 12.5e9,
        itemId: "legacy:gamma:peak:7",
        itemKind: "spectral_feature",
        ordinal: 7,
        peakIndex: 7,
        power: 0.25,
        sampleId: "gamma-spectrum-sample-0000",
      },
      "spin_wave_response.gamma.v1:sha256:gamma-1",
    );

    expect(selection).toEqual({
      artifactPath: ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
      artifactRevision: "spin_wave_response.gamma.v1:sha256:gamma-1",
      availability: "partial",
      executionState: "completed",
      frequencyHz: 12.5e9,
      frequencyIndex: 7,
      kind: "results.time_domain.spectral_feature",
      nodeId: "analysis:legacy:time-domain:legacy%3Agamma%3Apeak%3A7",
      pointId: "legacy:gamma:peak:7",
      resourceRef: ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
      resourceState: "ready",
      sampleId: "gamma-spectrum-sample-0000",
      sampleIndex: 0,
      source: "time-domain-response",
      studyProduct: "time_domain_spectrum",
      type: "frequency-domain",
    });
  });

  it("preserves DSF frequency and k coordinates without inventing a field", () => {
    const selection = legacyDsfPointSelectionRef(
      {
        frequencyHz: 2e9,
        frequencyIndex: 1,
        itemId: "legacy:dsf:1:0",
        itemKind: "dsf_point",
        kRadPerM: 10,
        ordinal: 2,
        power: 3,
        sampleId: "dsf-sample-0000",
        wavevectorIndex: 0,
      },
      "dynamic_structure_factor.1d.v1:sha256:dsf-1",
    );

    expect(selection).toMatchObject({
      artifactPath: ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
      artifactRevision: "dynamic_structure_factor.1d.v1:sha256:dsf-1",
      availability: "partial",
      frequencyHz: 2e9,
      frequencyIndex: 1,
      kContextKind: "k_path",
      kPathCoordinateRadPerM: 10,
      kind: "results.time_domain.dsf_point",
      pointId: "legacy:dsf:1:0",
      source: "time-domain-response",
    });
    expect(selection).not.toHaveProperty("fieldId");
  });

  it("fails closed when the legacy artifact revision is missing", () => {
    expect(
      legacyGammaFeatureSelectionRef(
        {
          frequencyHz: 12.5e9,
          itemId: "legacy:gamma:peak:7",
          itemKind: "spectral_feature",
          ordinal: 7,
          peakIndex: 7,
          power: 0.25,
          sampleId: "gamma-spectrum-sample-0000",
        },
        "",
      ),
    ).toBeNull();
  });

  it("turns a legacy reference into the kernel selection patch", () => {
    const ref = legacyGammaFeatureSelectionRef(
      {
        frequencyHz: 12.5e9,
        itemId: "legacy:gamma:peak:7",
        itemKind: "spectral_feature",
        ordinal: 7,
        peakIndex: 7,
        power: 0.25,
        sampleId: "gamma-spectrum-sample-0000",
      },
      "spin_wave_response.gamma.v1:sha256:gamma-1",
    );

    expect(ref).not.toBeNull();
    expect(legacyTimeDomainSelectionPatch(ref!, "Legacy spectral feature")).toEqual({
      kind: "results.time_domain.spectral_feature",
      label: "legacy:gamma:peak:7",
      nodeId: "analysis:legacy:time-domain:legacy%3Agamma%3Apeak%3A7",
      objectId: null,
      ref,
    });
  });
});

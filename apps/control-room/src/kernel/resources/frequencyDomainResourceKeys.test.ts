import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_PEAKS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
} from "../api/apiPaths";

import {
  canonicalFrequencyDomainResourceKey,
  frequencyDomainModeFieldMetaResourceKey,
} from "./frequencyDomainResourceKeys";

describe("frequency-domain resource keys", () => {
  it.each([
    ["field sweep", "eigen/field_sweep.v1.json", ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH],
    ["FMR peaks", "fmr/peaks.v1.json", ANALYSIS_FREQUENCY_DOMAIN_FMR_PEAKS_PATH],
    [
      "FMR resonance fits",
      "fmr/resonance_fits.v1.json",
      ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
    ],
    ["FMR Kittel fit", "fmr/kittel_fit.v1.json", ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH],
    [
      "manifest",
      "frequency_domain/manifest.v1.json",
      ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
    ],
  ])("maps the %s artifact path to its canonical HTTP resource key", (_label, artifactPath, resourceKey) => {
    expect(canonicalFrequencyDomainResourceKey(artifactPath)).toBe(resourceKey);
  });

  it("resolves concrete mode metadata keys from a mode artifact path", () => {
    const expected = frequencyDomainModeFieldMetaResourceKey(3, 7);

    expect(
      canonicalFrequencyDomainResourceKey("eigen/modes/sample_0003/mode_0007.json"),
    ).toBe(expected);
    expect(
      canonicalFrequencyDomainResourceKey(expected),
    ).toBe(expected);
    expect(ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH).toContain(
      "{sample_index}/{mode_index}/meta",
    );
  });

  it("does not invent keys for unrelated artifacts", () => {
    expect(canonicalFrequencyDomainResourceKey("eigen/unknown.v1.json")).toBeNull();
    expect(canonicalFrequencyDomainResourceKey("response/points.v1.json")).toBeNull();
  });
});

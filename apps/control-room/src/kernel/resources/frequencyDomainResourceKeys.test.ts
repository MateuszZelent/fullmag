import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_PEAKS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_COMPAT_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
} from "../api/apiPaths";

import {
  canonicalFrequencyDomainResourceKey,
  frequencyDomainModeFieldMetaResourceKey,
} from "./frequencyDomainResourceKeys";

describe("frequency-domain resource keys", () => {
  it.each([
    ["spectrum", "eigen/spectrum.v2.json", ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH],
    ["field sweep", "eigen/field_sweep.v1.json", ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH],
    ["branches", "eigen/branches.v2.json", ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH],
    ["dispersion", "eigen/dispersion.csv", ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH],
    [
      "eigen diagnostics",
      "eigen/diagnostics.v2.json",
      ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
    ],
    [
      "response magnetic sweep v2",
      "response/magnetic_response_sweep.v2.json",
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    ],
    [
      "response magnetic sweep v1",
      "response/magnetic_response_sweep.v1.json",
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    ],
    [
      "response progress",
      "response/progress.v1.json",
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    ],
    [
      "response cancel requested",
      "response/cancel_requested.v1.json",
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    ],
    [
      "response solver diagnostics",
      "response/diagnostics/solver.v1.json",
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
    ],
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

  it.each([
    [
      "response frequency point",
      "response/frequency_points/frequency_0007.json",
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
        "{frequency_index}",
        "7",
      ),
    ],
    [
      "response field metadata",
      "response/field_payloads/frequency_0008/vector.bin",
      ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.replace(
        "{frequency_index}",
        "8",
      ),
    ],
  ])(
    "maps the indexed %s artifact path to its concrete HTTP resource key",
    (_label, artifactPath, resourceKey) => {
      expect(canonicalFrequencyDomainResourceKey(artifactPath)).toBe(resourceKey);
      expect(canonicalFrequencyDomainResourceKey(resourceKey)).toBe(resourceKey);
    },
  );

  it.each([
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
    ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
    ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
    ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
    ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ])("keeps the canonical route stable while normalizing query and fragment", (resourceKey) => {
    expect(
      canonicalFrequencyDomainResourceKey(`${resourceKey}?revision=7#latest`),
    ).toBe(resourceKey);
  });

  it("normalizes the response diagnostics compatibility route to the hook key", () => {
    expect(
      canonicalFrequencyDomainResourceKey(
        ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_COMPAT_V1_PATH,
      ),
    ).toBe(ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH);
  });

  it.each([
    `${ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH.replace("{sample_index}", "-1").replace("{mode_index}", "2")}`,
    ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH.replace(
      "{sample_index}",
      "1.5",
    ).replace("{mode_index}", "2"),
    ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
      "{frequency_index}",
      "-1",
    ),
    ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
      "{frequency_index}",
      "1.5",
    ),
    ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.replace(
      "{frequency_index}",
      "frequency_7",
    ),
    "response/frequency_points/frequency_-1.json",
    "response/frequency_points/frequency_1.5.json",
    "eigen/modes/sample_4294967296/mode_0001.json",
    "response/field_payloads/frequency_0008/vector-copy.bin",
    "response/field_payloads/linked/frequency_0008_xyz.bin",
  ])("rejects an invalid or non-canonical indexed identity: %s", (value) => {
    expect(canonicalFrequencyDomainResourceKey(value)).toBeNull();
  });

  it("does not invent keys for unrelated artifacts", () => {
    expect(canonicalFrequencyDomainResourceKey("eigen/unknown.v1.json")).toBeNull();
    expect(canonicalFrequencyDomainResourceKey("response/points.v1.json")).toBeNull();
    expect(canonicalFrequencyDomainResourceKey("response/diagnostics.v1.json")).toBeNull();
  });
});

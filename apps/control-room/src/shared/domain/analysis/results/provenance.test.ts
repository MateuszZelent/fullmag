import { describe, expect, it } from "vitest";

import { analysisResultProvenanceRows } from "./provenance";

describe("analysis result provenance rows", () => {
  it("exposes typed time-domain sampling and FFT metadata", () => {
    const rows = analysisResultProvenanceRows({
      product_kind: "time_domain_spectrum",
      provenance: {
        detrend: "mean",
        normalization: "one-sided",
        nyquist_hz: "5e9",
        sampling_clock: "N=128; dt=1e-12 s",
        source_drive: "not published",
        uniformity_proof: "certified",
        window: "hann",
      },
    });
    expect(rows).toEqual([
      { label: "Sampling clock", mono: false, value: "N=128; dt=1e-12 s" },
      { label: "Uniformity proof", mono: false, value: "certified" },
      { label: "Window", mono: false, value: "hann" },
      { label: "Detrend", mono: false, value: "mean" },
      { label: "Normalization", mono: true, value: "one-sided" },
      { label: "Nyquist", mono: false, value: "5e9" },
      { label: "Source drive", mono: false, value: "not published" },
    ]);
  });

  it("does not expose frequency-domain metadata on a modal dataset", () => {
    expect(
      analysisResultProvenanceRows({
        product_kind: "modal_eigen",
        provenance: { sampling_clock: "must not be shown" },
      }),
    ).toEqual([]);
  });
});

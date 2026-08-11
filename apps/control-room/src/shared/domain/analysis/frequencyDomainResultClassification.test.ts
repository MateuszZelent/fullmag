import { describe, expect, it } from "vitest";

import {
  classifyFrequencyDomainResult,
  type FrequencyDomainResultEvidence,
} from "./frequencyDomainResultClassification";

const modalBase = {
  boundaryContext: "finite_open",
  equilibriumId: "equilibrium-1",
  observables: [],
  runId: "run-1",
  stageId: "stage-modal",
  studyProduct: "modal_eigen",
} satisfies FrequencyDomainResultEvidence;

const drivenBase = {
  boundaryContext: "finite_open",
  drive: { kind: "magnetic_rf", identity: "drive-rf-1" },
  equilibriumId: "equilibrium-1",
  observables: [],
  runId: "run-1",
  stageId: "stage-driven",
  studyProduct: "driven_response",
} satisfies FrequencyDomainResultEvidence;

describe("classifyFrequencyDomainResult", () => {
  it("classifies a finite open modal solve with k not applicable", () => {
    expect(classifyFrequencyDomainResult(modalBase)).toMatchObject({
      family: "resonance",
      kContext: { kind: "finite_open", label: "Finite system · k n/a" },
      productLabel: "Eigenmodes",
      resultLabel: "Eigenfrequency Spectrum",
      fmrQualified: false,
    });
  });

  it("classifies a periodic Gamma sample as resonance without inventing FMR activity", () => {
    expect(
      classifyFrequencyDomainResult({
        ...modalBase,
        boundaryContext: "floquet_periodic",
        kSampling: { kind: "single", vectorRadPerM: [0, 0, 0] },
      }),
    ).toMatchObject({
      family: "resonance",
      kContext: { kind: "gamma", label: "Γ point · k = 0" },
      resultLabel: "Eigenfrequency Spectrum",
      fmrQualified: false,
    });
  });

  it("classifies one nonzero k sample as fixed-k rather than dispersion", () => {
    expect(
      classifyFrequencyDomainResult({
        ...modalBase,
        boundaryContext: "floquet_periodic",
        kSampling: { kind: "single", vectorRadPerM: [1e7, 0, 0] },
      }),
    ).toMatchObject({
      family: "k_resolved",
      kContext: { kind: "fixed_k" },
      resultLabel: "Eigenfrequencies at fixed k",
      relationKind: "fixed_k_modal",
    });
  });

  it.each(["path", "grid"] as const)(
    "classifies modal %s sampling as f_n(k) dispersion",
    (kind) => {
      expect(
        classifyFrequencyDomainResult({
          ...modalBase,
          boundaryContext: "floquet_periodic",
          kSampling:
            kind === "path"
              ? { kind, sampleCount: 4, label: "Γ–X–M–Γ" }
              : { kind, sampleCount: 16 },
        }),
      ).toMatchObject({
        family: "k_resolved",
        kContext: { kind: kind === "path" ? "k_path" : "k_grid" },
        resultLabel: "Dispersion Relation · fₙ(k)",
        relationKind: "modal_dispersion",
      });
    },
  );

  it("qualifies modal FMR activity only from RF coupling evidence", () => {
    expect(
      classifyFrequencyDomainResult({
        ...modalBase,
        observables: [
          {
            kind: "rf_coupling",
            identity: "oscillator-strength",
            unit: "1",
          },
        ],
      }),
    ).toMatchObject({
      fmrQualified: true,
      resultLabel: "Eigenfrequency Spectrum",
      activityLabel: "RF Coupling / FMR Activity",
    });
  });

  it("uses a neutral harmonic-response name without a qualified observable", () => {
    expect(classifyFrequencyDomainResult(drivenBase)).toMatchObject({
      family: "resonance",
      productLabel: "Frequency Response",
      resultLabel: "Harmonic Response Spectrum",
      fmrQualified: false,
    });
  });

  it.each(["susceptibility", "absorbed_power", "drive_projected_response"] as const)(
    "qualifies driven FMR for magnetic RF drive and %s provenance",
    (kind) => {
      expect(
        classifyFrequencyDomainResult({
          ...drivenBase,
          observables: [{ kind, identity: `observable-${kind}`, unit: "1" }],
        }),
      ).toMatchObject({
        fmrQualified: true,
        resultLabel: "FMR Response Spectrum",
      });
    },
  );

  it("keeps a driven k path as A(k,f), not f(k)", () => {
    expect(
      classifyFrequencyDomainResult({
        ...drivenBase,
        boundaryContext: "floquet_periodic",
        kSampling: { kind: "path", sampleCount: 8, label: "Γ–X" },
        observables: [
          { kind: "response_amplitude", identity: "mx-amplitude", unit: "1" },
        ],
      }),
    ).toMatchObject({
      family: "k_resolved",
      resultLabel: "Spectral Response Map · A(k,f)",
      relationKind: "driven_response_map",
    });
  });

  it("fails closed when periodic boundaries omit k sampling", () => {
    expect(() =>
      classifyFrequencyDomainResult({
        ...modalBase,
        boundaryContext: "floquet_periodic",
      }),
    ).toThrow("Periodic/Floquet result requires explicit k sampling");
  });
});

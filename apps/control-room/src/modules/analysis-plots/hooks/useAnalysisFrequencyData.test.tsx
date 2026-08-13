import { describe, expect, it } from "vitest";

import { classifyFrequencyDomainResult } from "@/shared/domain/analysis/frequencyDomainResultClassification";
import { frequencyDomainChartTitle } from "./useAnalysisFrequencyData";

describe("useAnalysisFrequencyData utilities", () => {
  it("uses neutral names until typed physical evidence qualifies FMR", () => {
    expect(frequencyDomainChartTitle("modal-spectrum", null)).toBe("Eigenfrequency Spectrum");
    expect(frequencyDomainChartTitle("response-sweep", null)).toBe("Harmonic Response Spectrum");
    expect(frequencyDomainChartTitle("dispersion", null)).toBe("Dispersion Relation · fₙ(k)");

    const qualified = classifyFrequencyDomainResult({
      boundaryContext: "finite_open",
      drive: { identity: "rf-1", kind: "magnetic_rf" },
      equilibriumId: "eq-1",
      observables: [{ identity: "chi-xx", kind: "susceptibility", unit: "1" }],
      runId: "run-1",
      stageId: "response-1",
      studyProduct: "driven_response",
    });
    expect(frequencyDomainChartTitle("response-sweep", qualified)).toBe("FMR Response Spectrum");
  });
});

import { describe, expect, it } from "vitest";

import { frequencyDomainChartTitle } from "./useAnalysisFrequencyData";

describe("useAnalysisFrequencyData utilities", () => {
  it("frequencyDomainChartTitle formats title strings by calculation mode", () => {
    expect(frequencyDomainChartTitle("modal-spectrum", "fmr_modal")).toBe("FMR modal spectrum");
    expect(frequencyDomainChartTitle("modal-spectrum", "free_modes")).toBe("Frequency-domain modal spectrum");
    expect(frequencyDomainChartTitle("response-sweep", "fmr_response")).toBe("FMR response sweep");
    expect(frequencyDomainChartTitle("dispersion", "dispersion_modal")).toBe("Frequency-domain dispersion");
  });
});

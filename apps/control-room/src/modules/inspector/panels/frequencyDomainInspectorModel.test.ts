import { describe, expect, it } from "vitest";

import {
  buildFrequencyDomainCalculationModeRows,
  frequencyDomainResourceGroupLabel,
} from "./frequencyDomainInspectorModel";

describe("frequencyDomainInspectorModel", () => {
  it("builds calculation-mode rows from manifest capabilities", () => {
    const rows = buildFrequencyDomainCalculationModeRows(
      {
        boundary: {
          floquet_response: { status: "unsupported" },
        },
        dispersion: {
          k_path: { status: "ready" },
        },
        modal: {
          reference_cpu: { status: "ready" },
        },
        response: {
          magnetic_cpu: { status: "partial_production_executable" },
        },
      },
      false,
    );

    expect(rows.map((row) => row.mode)).toEqual([
      "fmr_modal",
      "fmr_response",
      "free_modes",
      "dispersion_modal",
      "response_map",
    ]);
    expect(rows.find((row) => row.mode === "fmr_modal")?.capabilityStatus).toBe(
      "reference_cpu: ready",
    );
    expect(rows.find((row) => row.mode === "fmr_response")?.capabilityStatus).toBe(
      "magnetic_cpu: partial_production_executable",
    );
    expect(
      rows.find((row) => row.mode === "dispersion_modal")?.capabilityStatus,
    ).toBe("k_path: ready");
    expect(rows.find((row) => row.mode === "response_map")?.capabilityStatus).toBe(
      "floquet_response: unsupported; nonzero-k response unavailable",
    );
  });

  it("labels frequency-domain resource-group nodes for inspectors", () => {
    expect(
      frequencyDomainResourceGroupLabel(
        "resources.analysis.frequency_domain.calculation_modes",
      ),
    ).toBe("Calculation mode resources");
    expect(
      frequencyDomainResourceGroupLabel("resources.analysis.frequency_domain.fmr"),
    ).toBe("FMR resource group");
    expect(
      frequencyDomainResourceGroupLabel(
        "resources.analysis.frequency_domain.dispersion",
      ),
    ).toBe("Dispersion resource group");
    expect(
      frequencyDomainResourceGroupLabel(
        "resources.analysis.frequency_domain.response_map",
      ),
    ).toBe("Response-map resource group");
  });
});

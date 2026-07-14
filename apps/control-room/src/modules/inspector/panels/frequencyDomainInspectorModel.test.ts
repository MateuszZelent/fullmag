import { describe, expect, it } from "vitest";

import {
  buildFrequencyDomainCalculationModeRows,
  frequencyDomainResourceGroupLabel,
  periodicStatusView,
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
    ).toBe(
      "reference_cpu: unknown; production_cpu: unknown; production_cpu_gamma_k_path: unknown; production_gpu: unknown; k_path: ready",
    );
    expect(rows.find((row) => row.mode === "response_map")?.capabilityStatus).toBe(
      "floquet_response: unsupported; nonzero-k response unavailable",
    );
  });

  it("keeps modal dispersion lane statuses explicit", () => {
    const rows = buildFrequencyDomainCalculationModeRows(
      {
        dispersion: {
          k_path: { status: "reference_executable" },
          production_cpu: { status: "partial_production_executable" },
          production_cpu_gamma_k_path: {
            status: "partial_production_executable",
          },
          production_gpu: { status: "unsupported" },
          reference_cpu: { status: "reference_executable" },
        },
      },
      false,
    );

    expect(
      rows.find((row) => row.mode === "dispersion_modal")?.capabilityStatus,
    ).toBe(
      "reference_cpu: reference_executable; production_cpu: partial_production_executable; production_cpu_gamma_k_path: partial_production_executable; production_gpu: unsupported; k_path: reference_executable",
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

  it.each([
    ["valid", "success", "valid"],
    ["invalid", "danger", "invalid"],
    ["stale", "warning", "stale"],
    ["unavailable", "neutral", "unavailable"],
  ] as const)("maps backend periodic status %s without inventing ready", (status, tone, label) => {
    expect(periodicStatusView(status)).toEqual({ tone, label });
  });

  it("treats a missing periodic status as unavailable", () => {
    expect(periodicStatusView(null)).toEqual({
      tone: "neutral",
      label: "unavailable",
    });
  });
});

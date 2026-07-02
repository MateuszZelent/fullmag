function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nestedStatus(value: unknown, ...path: readonly string[]): string {
  let current: unknown = value;
  for (const segment of path) {
    current = record(current)?.[segment];
  }
  const status = record(current)?.status;
  return typeof status === "string" && status.trim() ? status : "unknown";
}

function capabilityLabel(
  capabilities: unknown,
  label: string,
  ...path: readonly string[]
): string {
  return `${label}: ${nestedStatus(capabilities, ...path)}`;
}

function dispersionModalCapabilityLabel(capabilities: unknown): string {
  return [
    capabilityLabel(capabilities, "reference_cpu", "dispersion", "reference_cpu"),
    capabilityLabel(capabilities, "production_cpu", "dispersion", "production_cpu"),
    capabilityLabel(
      capabilities,
      "production_cpu_gamma_k_path",
      "dispersion",
      "production_cpu_gamma_k_path",
    ),
    capabilityLabel(capabilities, "production_gpu", "dispersion", "production_gpu"),
    capabilityLabel(capabilities, "k_path", "dispersion", "k_path"),
  ].join("; ");
}

export interface FrequencyDomainCalculationModeRow {
  artifacts: string;
  boundaryPreset: string;
  capabilityStatus: string;
  canonicalStudy: string;
  excitationRequirement: string;
  kRequirement: string;
  mode: string;
  sweepRequirement: string;
}

export function buildFrequencyDomainCalculationModeRows(
  capabilities: unknown,
  floquetNonzeroKResponseSupported: boolean | null | undefined,
): FrequencyDomainCalculationModeRow[] {
  return [
    {
      artifacts: "spectrum.v2 + mode fields",
      boundaryPreset: "free/open or static periodic",
      capabilityStatus: capabilityLabel(
        capabilities,
        "reference_cpu",
        "modal",
        "reference_cpu",
      ),
      canonicalStudy: "Eigenmodes",
      excitationRequirement: "not required",
      kRequirement: "k = 0 / no k-path",
      mode: "fmr_modal",
      sweepRequirement: "not required",
    },
    {
      artifacts: "response sweep + frequency points + fields",
      boundaryPreset: "free/open or static periodic",
      capabilityStatus: capabilityLabel(
        capabilities,
        "magnetic_cpu",
        "response",
        "magnetic_cpu",
      ),
      canonicalStudy: "FrequencyResponse",
      excitationRequirement: "harmonic excitation required",
      kRequirement: "k = 0",
      mode: "fmr_response",
      sweepRequirement: "frequency sweep required",
    },
    {
      artifacts: "spectrum.v2 + mode fields",
      boundaryPreset: "free/open",
      capabilityStatus: capabilityLabel(
        capabilities,
        "reference_cpu",
        "modal",
        "reference_cpu",
      ),
      canonicalStudy: "Eigenmodes",
      excitationRequirement: "not required",
      kRequirement: "no k-path",
      mode: "free_modes",
      sweepRequirement: "not required",
    },
    {
      artifacts: "dispersion.csv + branches.v2 + mode fields",
      boundaryPreset: "Floquet/Bloch k-path",
      capabilityStatus: dispersionModalCapabilityLabel(capabilities),
      canonicalStudy: "Eigenmodes",
      excitationRequirement: "not required",
      kRequirement: "k-path required",
      mode: "dispersion_modal",
      sweepRequirement: "not required",
    },
    {
      artifacts: "response map + field slices",
      boundaryPreset: "Floquet/Bloch k/f grid",
      capabilityStatus: `${capabilityLabel(
        capabilities,
        "floquet_response",
        "boundary",
        "floquet_response",
      )}; ${
        floquetNonzeroKResponseSupported
          ? "nonzero-k response available"
          : "nonzero-k response unavailable"
      }`,
      canonicalStudy: "FrequencyResponse",
      excitationRequirement: "harmonic excitation required",
      kRequirement: "k/f grid required",
      mode: "response_map",
      sweepRequirement: "frequency sweep required",
    },
  ];
}

export function frequencyDomainResourceGroupLabel(kind: string): string {
  if (kind === "resources.analysis.frequency_domain.calculation_modes") {
    return "Calculation mode resources";
  }
  if (kind === "resources.analysis.frequency_domain.fmr") {
    return "FMR resource group";
  }
  if (kind === "resources.analysis.frequency_domain.dispersion") {
    return "Dispersion resource group";
  }
  if (kind === "resources.analysis.frequency_domain.response_map") {
    return "Response-map resource group";
  }
  return "frequency-domain resources";
}

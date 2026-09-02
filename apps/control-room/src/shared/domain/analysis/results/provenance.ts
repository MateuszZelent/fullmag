import type { AnalysisResultDatasetManifestResource } from "./types";

export interface AnalysisResultProvenanceRow {
  label: string;
  mono?: boolean;
  value: string;
}

const TIME_DOMAIN_FIELDS = [
  ["sampling_clock", "Sampling clock", false],
  ["uniformity_proof", "Uniformity proof", false],
  ["window", "Window", false],
  ["detrend", "Detrend", false],
  ["normalization", "Normalization", true],
  ["nyquist_hz", "Nyquist", false],
  ["response_components", "Response components", false],
  ["source_drive", "Source drive", false],
] as const;

const DSF_FIELDS = [
  ["sampling_clock", "Sampling clock", false],
  ["uniformity_proof", "Uniformity proof", false],
  ["window", "Window", false],
  ["normalization", "Normalization", true],
  ["spatial_axis", "Spatial axis", false],
  ["source_observable", "Source observable", false],
  ["source_drive", "Source signal", false],
  ["phase_convention", "Phase convention", true],
  ["mesh_probe_signature", "Mesh probe signature", true],
  ["array_bounds", "Array bounds", false],
] as const;

export function analysisResultProvenanceRows(
  manifest: Pick<
    AnalysisResultDatasetManifestResource,
    "product_kind" | "provenance"
  > | null | undefined,
): readonly AnalysisResultProvenanceRow[] {
  if (!manifest) return [];
  const fields = manifest.product_kind === "time_domain_spectrum"
    ? TIME_DOMAIN_FIELDS
    : manifest.product_kind === "dynamic_structure_factor"
      ? DSF_FIELDS
      : [];
  return fields.flatMap(([key, label, mono]) => {
    const value = manifest.provenance[key];
    return typeof value === "string" && value.trim().length > 0
      ? [{ label, mono, value }]
      : [];
  });
}

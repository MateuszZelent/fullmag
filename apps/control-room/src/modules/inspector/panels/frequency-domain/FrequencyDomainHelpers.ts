import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import type { FmrPeakPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  ANALYSIS_FIELD_VIEW_OPTIONS,
  DEFAULT_ANALYSIS_FIELD_VIEW,
  normalizeAnalysisFieldView,
} from "../FrequencyDomainModeDisplayControls";

export function formatBoolean(value: boolean | null | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "not available";
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "resource load failed";
}

export function familyLabel(kind: string | null): string {
  if (!kind) return "Frequency-domain";
  if (kind.startsWith("results.eigen")) return "Modal eigen / dispersion";
  if (kind.startsWith("results.frequency_response")) {
    return "Driven frequency response";
  }
  if (kind === "resources.mesh.periodic_pairs") {
    return "Periodic / Floquet mesh resource";
  }
  return "Frequency-domain";
}

export function formatList(values: readonly string[] | null | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "not reported";
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatNumber(value: unknown, unit = ""): string {
  const parsed = finiteNumber(value);
  if (parsed == null) return "not available";
  return `${parsed}${unit}`;
}

export function formatFrequency(valueHz: unknown): string {
  const parsed = finiteNumber(valueHz);
  return formatFrequencyHz(parsed);
}

export function arrayLength(value: unknown): string {
  return Array.isArray(value) ? String(value.length) : "not available";
}

export function formatRecordField(
  value: unknown,
  key: string,
  fallback = "not available",
): string {
  const item = record(value)?.[key];
  if (typeof item === "string" && item.trim()) return item;
  if (typeof item === "boolean") return formatBoolean(item);
  const numeric = finiteNumber(item);
  return numeric == null ? fallback : String(numeric);
}

export function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = finiteNumber(item);
        return parsed == null ? [] : [parsed];
      })
    : [];
}

export function susceptibilityPairCount(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "not available";
  return String(value.length);
}

export function maxAbsComplexPairs(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let maxValue: number | null = null;
  for (const pair of value) {
    if (!Array.isArray(pair)) continue;
    const real = finiteNumber(pair[0]);
    const imag = finiteNumber(pair[1]);
    if (real == null || imag == null) continue;
    const magnitude = Math.hypot(real, imag);
    maxValue = maxValue == null ? magnitude : Math.max(maxValue, magnitude);
  }
  return maxValue;
}

export function formatScalar(value: number | null | undefined, unit = ""): string {
  if (value == null || !Number.isFinite(value)) return "not available";
  if (Math.abs(value) < 1e-12) return `0${unit}`;
  if (Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3) {
    return `${value.toExponential(3)}${unit}`;
  }
  return `${Number(value.toPrecision(5))}${unit}`;
}

export function analysisFieldViewOptions(
  availableViews: readonly string[] | null | undefined,
  defaultView: string | null | undefined,
): string[] {
  const normalized = (availableViews ?? ANALYSIS_FIELD_VIEW_OPTIONS).map(
    normalizeAnalysisFieldView,
  );
  const options = Array.from(new Set(normalized));
  const normalizedDefault = normalizeAnalysisFieldView(defaultView);
  const orderedOptions = [
    normalizedDefault,
    ...options.filter((option) => option !== normalizedDefault),
  ];
  return orderedOptions.length > 0 ? orderedOptions : [DEFAULT_ANALYSIS_FIELD_VIEW];
}

export function selectedField3DPlotStatus(
  meta: {
    component_basis?: string | null;
    component_count?: number | null;
    resource_key?: string | null;
    value_kind?: string | null;
  } | null | undefined,
): string {
  if (!meta?.resource_key) {
    return "Selected frequency-domain field is missing a data-plane resource";
  }
  if (
    meta.component_basis === "local_tangent_frame" ||
    meta.value_kind === "complex_tangent_vector" ||
    (meta.component_count != null && meta.component_count !== 3)
  ) {
    return "requires tangent-to-XYZ reconstruction artifact";
  }
  return "ready for spatial XYZ field";
}

export function canPlotSelectedFieldIn3D(
  meta: {
    component_basis?: string | null;
    component_count?: number | null;
    resource_key?: string | null;
    value_kind?: string | null;
  } | null | undefined,
): boolean {
  return selectedField3DPlotStatus(meta) === "ready for spatial XYZ field";
}

export function floquetKVectorFromManifest(manifestPayload: unknown): number[] {
  const payload = record(manifestPayload);
  const spinWaveBc = record(payload?.spin_wave_bc ?? payload?.spinWaveBc);
  return numberArray(
    spinWaveBc?.floquet_k_vector_rad_per_m ??
      spinWaveBc?.k_vector_rad_per_m ??
      spinWaveBc?.k_vector,
  );
}

export function firstPeriodicPair(pairs: readonly unknown[]): Record<string, unknown> | null {
  return pairs.map(record).find((pair): pair is Record<string, unknown> => !!pair) ?? null;
}

export function pairTranslation(pair: Record<string, unknown> | null): number[] {
  return numberArray(
    pair?.expected_translation_m ??
      pair?.translation_m ??
      pair?.delta_r_m ??
      pair?.delta_r,
  );
}

export function dotProduct(left: readonly number[], right: readonly number[]): number | null {
  if (left.length === 0 || right.length === 0) return null;
  const length = Math.min(left.length, right.length);
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value += left[index]! * right[index]!;
  }
  return value;
}

export function invalidPeriodicPairCount(pairs: readonly unknown[]): number {
  return pairs.filter((entry) => {
    const pair = record(entry);
    if (!pair) return true;
    const status = String(pair.status ?? "").toLowerCase();
    const unpairedSource = finiteNumber(pair.unpaired_source_node_count) ?? 0;
    const unpairedDestination = finiteNumber(pair.unpaired_destination_node_count) ?? 0;
    return status !== "ready" || unpairedSource > 0 || unpairedDestination > 0;
  }).length;
}

export function maxPeriodicPairResidual(pairs: readonly unknown[]): number | null {
  const residuals = pairs.flatMap((item) => {
    const pair = record(item);
    return [
      finiteNumber(pair?.max_residual_m),
      finiteNumber(pair?.rms_residual_m),
    ].flatMap((value) => (value == null ? [] : [value]));
  });
  return residuals.length > 0 ? Math.max(...residuals) : null;
}

export function parseKPathSummary(csv: string | null | undefined): {
  endpointLabels: string;
  pathSRange: string;
  sampleCount: number;
} {
  const lines = (csv ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { endpointLabels: "not available", pathSRange: "not available", sampleCount: 0 };
  }
  const headers = lines[0]?.split(",").map((item) => item.trim()) ?? [];
  const rows = lines.slice(1).map((line) => {
    const columns = line.split(",").map((item) => item.trim());
    return Object.fromEntries(headers.map((header, index) => [header, columns[index]]));
  });
  const pathValues = rows.flatMap((row) => {
    const value = finiteNumber(row.path_s_rad_per_m ?? row.path_s ?? row.pathS);
    return value == null ? [] : [value];
  });
  const labels = rows.flatMap((row) => {
    const value = row.endpoint_label ?? row.k_label ?? row.label;
    return typeof value === "string" && value ? [value] : [];
  });
  return {
    endpointLabels:
      labels.length > 0 ? `${labels[0]} -> ${labels[labels.length - 1]}` : "not available",
    pathSRange:
      pathValues.length > 0
        ? `${Math.min(...pathValues)}-${Math.max(...pathValues)} rad/m`
        : "not available",
    sampleCount: pathValues.length,
  };
}

export function isFrequencyDomainKind(
  kind: string,
  ...matches: readonly string[]
): boolean {
  return matches.some((match) => kind === match || kind.startsWith(`${match}.`));
}

export function isExactFrequencyDomainKind(
  kind: string,
  ...matches: readonly string[]
): boolean {
  return matches.includes(kind);
}

export function modePointKey(point: {
  rawModeIndex: number;
  sampleIndex: number;
}): string {
  return `${point.sampleIndex}:${point.rawModeIndex}`;
}

export function modePointLabel(point: {
  frequencyHz: number;
  rawModeIndex: number;
  sampleIndex: number;
}): string {
  return `sample ${point.sampleIndex}, mode ${point.rawModeIndex}, ${formatFrequency(point.frequencyHz)}`;
}

export function fmrPeakKey(peak: FmrPeakPoint): string {
  const modalRef = peak.modeRef
    ? `sample-${peak.modeRef.sampleIndex}:mode-${peak.modeRef.rawModeIndex}`
    : "no-mode";
  const responseRef =
    peak.frequencyPointIndex == null
      ? "no-response-point"
      : `frequency-${peak.frequencyPointIndex}`;
  return `${peak.source}:${peak.frequencyHz}:${modalRef}:${responseRef}`;
}

export function fmrPeakLabel(peak: FmrPeakPoint): string {
  const target =
    peak.modeRef != null
      ? `sample ${peak.modeRef.sampleIndex} mode ${peak.modeRef.rawModeIndex}`
      : peak.frequencyPointIndex != null
        ? `frequency point ${peak.frequencyPointIndex}`
        : "unmapped target";
  return `${peak.source}, ${formatFrequency(peak.frequencyHz)}, ${target}`;
}

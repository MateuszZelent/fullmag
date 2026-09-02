import type { DynamicStructureFactorResource } from "@/kernel/api/apiTypes";
import { ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH } from "@/kernel/api/apiPaths";

import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

export interface StructureFactorCell {
  frequencyHz: number;
  kRadPerM: number;
  normalizedPower: number;
  logNormalizedPower: number;
  power: number;
  frequencyIndex: number;
  wavevectorIndex: number;
}

export interface DynamicStructureFactorPointSelection {
  frequencyHz: number;
  frequencyIndex: number;
  itemId: string;
  itemKind: "dsf_point";
  kRadPerM: number;
  ordinal: number;
  power: number;
  sampleId: string;
  wavevectorIndex: number;
}

const MAX_HEATMAP_CELLS = 4096;
const MAX_LINE_CUT_POINTS = 50;
const LEGACY_DSF_SAMPLE_ID = "dsf-sample-0000";

type DynamicStructureFactorSpectrum = "response" | "source";

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function spectrumPowers(
  resource: DynamicStructureFactorResource,
  spectrum: DynamicStructureFactorSpectrum,
): readonly number[] {
  return spectrum === "source" ? resource.source_power : resource.power;
}

function dynamicStructureFactorSourceIndices(
  frequencyCount: number,
  wavevectorCount: number,
): { frequency: number[]; wavevector: number[] } {
  let frequencyStride = 1;
  let wavevectorStride = 1;
  while (
    Math.ceil(frequencyCount / frequencyStride) * Math.ceil(wavevectorCount / wavevectorStride) >
    MAX_HEATMAP_CELLS
  ) {
    if (frequencyCount / frequencyStride >= wavevectorCount / wavevectorStride) frequencyStride += 1;
    else wavevectorStride += 1;
  }
  return {
    frequency: indicesWithStride(frequencyCount, frequencyStride),
    wavevector: indicesWithStride(wavevectorCount, wavevectorStride),
  };
}

function indicesWithStride(count: number, stride: number): number[] {
  const indices: number[] = [];
  for (let index = 0; index < count; index += stride) indices.push(index);
  return indices;
}

function hasConsistentGrid(
  resource: DynamicStructureFactorResource,
  spectrum: DynamicStructureFactorSpectrum,
): boolean {
  const cellCount = resource.frequency_count * resource.wavevector_count;
  return (
    resource.artifact_ref.trim().length > 0 &&
    isPositiveInteger(resource.frequency_count) &&
    isPositiveInteger(resource.wavevector_count) &&
    isPositiveInteger(resource.original_frequency_count) &&
    isPositiveInteger(resource.original_wavevector_count) &&
    resource.frequency_hz.length === resource.frequency_count &&
    resource.k_rad_per_m.length === resource.wavevector_count &&
    resource.invalid_probe_mask.length === resource.wavevector_count &&
    spectrumPowers(resource, spectrum).length === cellCount &&
    resource.original_frequency_count >= resource.frequency_count &&
    resource.original_wavevector_count >= resource.wavevector_count
  );
}

function boundedIndices(count: number, maximum: number): number[] {
  const stride = Math.max(1, Math.ceil(count / maximum));
  const indices: number[] = [];
  for (let index = 0; index < count; index += stride) indices.push(index);
  return indices;
}

export function dynamicStructureFactorPointSelection(
  resource: DynamicStructureFactorResource | null,
  frequencyIndex: number,
  wavevectorIndex: number,
  spectrum: DynamicStructureFactorSpectrum = "response",
): DynamicStructureFactorPointSelection | null {
  if (
    !resource ||
    !resource.artifact_ref.trim() ||
    !hasConsistentGrid(resource, spectrum) ||
    !Number.isInteger(frequencyIndex) ||
    !Number.isInteger(wavevectorIndex)
  ) return null;
  if (
    frequencyIndex < 0 ||
    frequencyIndex >= resource.frequency_count ||
    wavevectorIndex < 0 ||
    wavevectorIndex >= resource.wavevector_count
  ) return null;
  if (resource.invalid_probe_mask?.[wavevectorIndex] !== false) return null;
  const originalFrequencyCount = resource.original_frequency_count;
  const originalWavevectorCount = resource.original_wavevector_count;
  const sourceIndices = dynamicStructureFactorSourceIndices(
    originalFrequencyCount,
    originalWavevectorCount,
  );
  if (
    sourceIndices.frequency.length !== resource.frequency_count ||
    sourceIndices.wavevector.length !== resource.wavevector_count
  ) return null;
  const sourceFrequencyIndex = sourceIndices.frequency[frequencyIndex];
  const sourceWavevectorIndex = sourceIndices.wavevector[wavevectorIndex];
  if (sourceFrequencyIndex == null || sourceWavevectorIndex == null) return null;
  const frequencyHz = resource.frequency_hz[frequencyIndex];
  const kRadPerM = resource.k_rad_per_m[wavevectorIndex];
  const power = spectrumPowers(resource, spectrum)[
    frequencyIndex * resource.wavevector_count + wavevectorIndex
  ];
  if (!Number.isFinite(frequencyHz) || !Number.isFinite(kRadPerM) || !Number.isFinite(power)) return null;
  return {
    frequencyHz,
    frequencyIndex,
    itemId: `legacy:dsf:${sourceFrequencyIndex}:${sourceWavevectorIndex}`,
    itemKind: "dsf_point",
    kRadPerM,
    ordinal: sourceFrequencyIndex * originalWavevectorCount + sourceWavevectorIndex,
    power,
    sampleId: LEGACY_DSF_SAMPLE_ID,
    wavevectorIndex,
  };
}

export function dynamicStructureFactorCells(
  resource: DynamicStructureFactorResource | null,
  spectrum: DynamicStructureFactorSpectrum = "response",
): StructureFactorCell[] {
  if (!resource || !hasConsistentGrid(resource, spectrum)) return [];
  const powers = spectrumPowers(resource, spectrum);
  let frequencyStride = 1;
  let wavevectorStride = 1;
  while (Math.ceil(resource.frequency_count / frequencyStride) * Math.ceil(resource.wavevector_count / wavevectorStride) > MAX_HEATMAP_CELLS) {
    if (resource.frequency_count / frequencyStride >= resource.wavevector_count / wavevectorStride) frequencyStride += 1;
    else wavevectorStride += 1;
  }
  let maximum = 0;
  let floor = Number.POSITIVE_INFINITY;
  for (const power of powers) {
    if (!Number.isFinite(power)) continue;
    maximum = Math.max(maximum, power);
    if (power > 0) floor = Math.min(floor, power);
  }
  if (!Number.isFinite(floor)) floor = 1;
  const logRange = maximum > floor ? Math.log10(maximum / floor) : 1;
  const cells: StructureFactorCell[] = [];
  for (let frequencyIndex = 0; frequencyIndex < resource.frequency_count; frequencyIndex += frequencyStride) {
    for (let wavevectorIndex = 0; wavevectorIndex < resource.wavevector_count; wavevectorIndex += wavevectorStride) {
      const rawPower = powers[frequencyIndex * resource.wavevector_count + wavevectorIndex] ?? 0;
      const power = Number.isFinite(rawPower) && rawPower >= 0 ? rawPower : 0;
      cells.push({
        frequencyHz: Number.isFinite(resource.frequency_hz[frequencyIndex])
          ? resource.frequency_hz[frequencyIndex]!
          : 0,
        kRadPerM: Number.isFinite(resource.k_rad_per_m[wavevectorIndex])
          ? resource.k_rad_per_m[wavevectorIndex]!
          : 0,
        normalizedPower: maximum > 0 ? power / maximum : 0,
        logNormalizedPower: power > 0 && maximum > 0 ? Math.max(0, 1 + Math.log10(power / maximum) / logRange) : 0,
        power,
        frequencyIndex,
        wavevectorIndex,
      });
    }
  }
  return cells;
}

function source() {
  return { kind: "analysis.spin_wave" as const, resourceKey: ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH, tableId: "dynamic-structure-factor" };
}

export function dynamicStructureFactorFrequencyCut(resource: DynamicStructureFactorResource | null, wavevectorIndex: number, spectrum: "response" | "source" = "response"): ChartSeries[] {
  if (!resource || !hasConsistentGrid(resource, spectrum) || wavevectorIndex < 0 || wavevectorIndex >= resource.wavevector_count) return [];
  const powers = spectrum === "source" ? resource.source_power : resource.power;
  const quantity = spectrum === "source" ? `|${resource.source_observable}(k,f)|²` : "S(k,f)";
  const frequencyIndices = boundedIndices(resource.frequency_count, MAX_LINE_CUT_POINTS);
  return [{ id: `finite-k-frequency-cut-${spectrum}`, label: `${quantity}, k=${resource.k_rad_per_m[wavevectorIndex]?.toExponential(3)}`, quantity, source: source(), status: "ready", unit: spectrum === "source" ? `(${resource.source_unit})²` : "1", xUnit: resource.frequency_unit,
    points: frequencyIndices.map((frequencyIndex) => ({ rowIndex: frequencyIndex, x: resource.frequency_hz[frequencyIndex]!, y: powers[frequencyIndex * resource.wavevector_count + wavevectorIndex] ?? 0 })) }];
}

export function dynamicStructureFactorWavevectorCut(resource: DynamicStructureFactorResource | null, frequencyIndex: number, spectrum: "response" | "source" = "response"): ChartSeries[] {
  if (!resource || !hasConsistentGrid(resource, spectrum) || frequencyIndex < 0 || frequencyIndex >= resource.frequency_count) return [];
  const powers = spectrum === "source" ? resource.source_power : resource.power;
  const quantity = spectrum === "source" ? `|${resource.source_observable}(k,f)|²` : "S(k,f)";
  const wavevectorIndices = boundedIndices(resource.wavevector_count, MAX_LINE_CUT_POINTS);
  return [{ id: `finite-k-wavevector-cut-${spectrum}`, label: `${quantity}, f=${resource.frequency_hz[frequencyIndex]?.toExponential(3)}`, quantity, source: source(), status: "ready", unit: spectrum === "source" ? `(${resource.source_unit})²` : "1", xUnit: resource.wavevector_unit,
    points: wavevectorIndices.map((wavevectorIndex) => ({ rowIndex: wavevectorIndex, x: resource.k_rad_per_m[wavevectorIndex]!, y: powers[frequencyIndex * resource.wavevector_count + wavevectorIndex] ?? 0 })) }];
}

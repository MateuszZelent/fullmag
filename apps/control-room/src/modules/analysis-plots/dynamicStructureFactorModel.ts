import type { DynamicStructureFactorResource } from "@/kernel/api/apiTypes";
import { ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH } from "@/kernel/api/apiPaths";

import type { ChartSeries } from "./chartTableModel";

export interface StructureFactorCell {
  frequencyHz: number;
  kRadPerM: number;
  normalizedPower: number;
  logNormalizedPower: number;
  power: number;
  frequencyIndex: number;
  wavevectorIndex: number;
}

const MAX_HEATMAP_CELLS = 4096;

export function dynamicStructureFactorCells(
  resource: DynamicStructureFactorResource | null,
  spectrum: "response" | "source" = "response",
): StructureFactorCell[] {
  if (!resource) return [];
  const powers = spectrum === "source" ? resource.source_power : resource.power;
  let frequencyStride = 1;
  let wavevectorStride = 1;
  while (Math.ceil(resource.frequency_count / frequencyStride) * Math.ceil(resource.wavevector_count / wavevectorStride) > MAX_HEATMAP_CELLS) {
    if (resource.frequency_count / frequencyStride >= resource.wavevector_count / wavevectorStride) frequencyStride += 1;
    else wavevectorStride += 1;
  }
  const maximum = powers.reduce((value, candidate) => Math.max(value, candidate), 0);
  const positive = powers.filter((value) => value > 0);
  const floor = positive.length > 0 ? Math.min(...positive) : 1;
  const logRange = maximum > floor ? Math.log10(maximum / floor) : 1;
  const cells: StructureFactorCell[] = [];
  for (let frequencyIndex = 0; frequencyIndex < resource.frequency_count; frequencyIndex += frequencyStride) {
    for (let wavevectorIndex = 0; wavevectorIndex < resource.wavevector_count; wavevectorIndex += wavevectorStride) {
      const power = powers[frequencyIndex * resource.wavevector_count + wavevectorIndex] ?? 0;
      cells.push({
        frequencyHz: resource.frequency_hz[frequencyIndex] ?? 0,
        kRadPerM: resource.k_rad_per_m[wavevectorIndex] ?? 0,
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
  if (!resource || wavevectorIndex < 0 || wavevectorIndex >= resource.wavevector_count) return [];
  const powers = spectrum === "source" ? resource.source_power : resource.power;
  const quantity = spectrum === "source" ? `|${resource.source_observable}(k,f)|²` : "S(k,f)";
  return [{ id: `finite-k-frequency-cut-${spectrum}`, label: `${quantity}, k=${resource.k_rad_per_m[wavevectorIndex]?.toExponential(3)}`, quantity, source: source(), status: "ready", unit: spectrum === "source" ? `(${resource.source_unit})²` : "1", xUnit: resource.frequency_unit,
    points: resource.frequency_hz.map((x, frequencyIndex) => ({ rowIndex: frequencyIndex, x, y: powers[frequencyIndex * resource.wavevector_count + wavevectorIndex] ?? 0 })) }];
}

export function dynamicStructureFactorWavevectorCut(resource: DynamicStructureFactorResource | null, frequencyIndex: number, spectrum: "response" | "source" = "response"): ChartSeries[] {
  if (!resource || frequencyIndex < 0 || frequencyIndex >= resource.frequency_count) return [];
  const powers = spectrum === "source" ? resource.source_power : resource.power;
  const quantity = spectrum === "source" ? `|${resource.source_observable}(k,f)|²` : "S(k,f)";
  return [{ id: `finite-k-wavevector-cut-${spectrum}`, label: `${quantity}, f=${resource.frequency_hz[frequencyIndex]?.toExponential(3)}`, quantity, source: source(), status: "ready", unit: spectrum === "source" ? `(${resource.source_unit})²` : "1", xUnit: resource.wavevector_unit,
    points: resource.k_rad_per_m.map((x, wavevectorIndex) => ({ rowIndex: wavevectorIndex, x, y: powers[frequencyIndex * resource.wavevector_count + wavevectorIndex] ?? 0 })) }];
}

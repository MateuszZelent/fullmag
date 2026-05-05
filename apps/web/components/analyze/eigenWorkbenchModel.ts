"use client";

import type {
  EigenBranchesArtifact,
  EigenSelection,
  EigenTrackedBranch,
} from "./eigenTypes";
import type { normalizeSpectrumArtifact } from "./eigenTypes";

type NormalizedSpectrum = ReturnType<typeof normalizeSpectrumArtifact>;

export interface EigenWorkbenchColors {
  selected: string;
  trace: string;
  trace2: string;
}

export function eigenGhz(valueHz: number): number {
  return valueHz / 1e9;
}

export function defaultEigenSelection(
  spectrum: NormalizedSpectrum,
  branches?: EigenBranchesArtifact | null,
): EigenSelection | null {
  if (!spectrum || spectrum.samples.length === 0) {
    return null;
  }
  if (branches && branches.branches.length > 0 && branches.branches[0].points.length > 0) {
    const point = branches.branches[0].points[0];
    return {
      sampleIndex: point.sample_index,
      rawModeIndex: point.raw_mode_index,
      branchId: branches.branches[0].branch_id,
    };
  }
  const firstSample = spectrum.samples[0];
  const firstMode = firstSample.modes[0];
  if (!firstMode) {
    return null;
  }
  return {
    sampleIndex: firstSample.sample_index,
    rawModeIndex: firstMode.raw_mode_index,
    branchId: firstMode.branch_id ?? null,
  };
}

export function eigenModeFromSelection(
  spectrum: NormalizedSpectrum,
  selection: EigenSelection | null,
) {
  if (!spectrum || !selection || selection.rawModeIndex == null) {
    return null;
  }
  const sample = spectrum.samples.find((item) => item.sample_index === selection.sampleIndex);
  return sample?.modes.find((mode) => mode.raw_mode_index === selection.rawModeIndex) ?? null;
}

export function selectedEigenBranch(
  branches: EigenBranchesArtifact | null | undefined,
  selection: EigenSelection | null,
): EigenTrackedBranch | null {
  if (!branches || !selection || selection.branchId == null) {
    return null;
  }
  return branches.branches.find((branch) => branch.branch_id === selection.branchId) ?? null;
}

export function buildEigenPathTickLabels(spectrum: NormalizedSpectrum): {
  value: number;
  label: string;
}[] {
  const ticks: { value: number; label: string }[] = [];
  for (const sample of spectrum?.samples ?? []) {
    if (sample.label) {
      ticks.push({ value: sample.path_s, label: sample.label });
    }
  }
  return ticks;
}

export function buildEigenSpectrumTrace(
  spectrum: NormalizedSpectrum,
  selection: EigenSelection | null,
  colors: EigenWorkbenchColors,
) {
  const sample =
    spectrum?.samples.find((item) => item.sample_index === selection?.sampleIndex)
    ?? spectrum?.samples[0];
  if (!sample) {
    return [];
  }
  return [
    {
      x: sample.modes.map((mode) => mode.raw_mode_index),
      y: sample.modes.map((mode) => eigenGhz(mode.frequency_real_hz)),
      type: "scatter" as const,
      mode: "markers" as const,
      customdata: sample.modes.map((mode) => mode.raw_mode_index),
      marker: {
        size: sample.modes.map((mode) =>
          mode.raw_mode_index === selection?.rawModeIndex ? 13 : 8,
        ),
        color: sample.modes.map((mode) =>
          mode.raw_mode_index === selection?.rawModeIndex ? colors.selected : colors.trace,
        ),
      },
      hovertemplate: "mode %{customdata}<br>f = %{y:.4f} GHz<extra></extra>",
      showlegend: false,
    },
  ];
}

export function buildEigenDispersionTraces(
  spectrum: NormalizedSpectrum,
  branches: EigenBranchesArtifact | null | undefined,
  selection: EigenSelection | null,
  colors: EigenWorkbenchColors,
) {
  if (!spectrum || !branches || branches.branches.length === 0) {
    return [];
  }
  const sampleByIndex = new Map(spectrum.samples.map((sample) => [sample.sample_index, sample]));
  return branches.branches.map((branch, index) => ({
    x: branch.points.map(
      (point) => sampleByIndex.get(point.sample_index)?.path_s ?? point.sample_index,
    ),
    y: branch.points.map((point) => eigenGhz(point.frequency_real_hz)),
    type: "scatter" as const,
    mode: branch.points.length > 1 ? ("lines+markers" as const) : ("markers" as const),
    customdata: branch.points.map((point) => [
      branch.branch_id,
      point.sample_index,
      point.raw_mode_index,
    ]),
    name: branch.label ?? `B${branch.branch_id}`,
    line: {
      width: branch.branch_id === selection?.branchId ? 3 : 1.5,
      color:
        branch.branch_id === selection?.branchId
          ? colors.selected
          : index % 2 === 0
            ? colors.trace
            : colors.trace2,
    },
    marker: {
      size: branch.points.map((point) =>
        point.raw_mode_index === selection?.rawModeIndex
        && point.sample_index === selection?.sampleIndex
          ? 10
          : 6,
      ),
    },
    hovertemplate:
      "branch %{customdata[0]}<br>path_s %{x:.4g}<br>sample %{customdata[1]}<br>mode %{customdata[2]}<br>f = %{y:.4f} GHz<extra></extra>",
  }));
}

export function eigenSelectionFromSpectrumCustomData(
  raw: unknown,
  spectrum: NormalizedSpectrum,
  currentSelection: EigenSelection | null,
): EigenSelection | null {
  if (typeof raw !== "number" || !spectrum) {
    return null;
  }
  const sampleIndex = currentSelection?.sampleIndex ?? spectrum.samples[0]?.sample_index ?? 0;
  return {
    sampleIndex,
    rawModeIndex: raw,
    branchId:
      spectrum.samples
        .find((item) => item.sample_index === sampleIndex)
        ?.modes.find((mode) => mode.raw_mode_index === raw)?.branch_id ?? null,
  };
}

export function eigenSelectionFromDispersionCustomData(raw: unknown): EigenSelection | null {
  if (!Array.isArray(raw) || raw.length < 3) {
    return null;
  }
  return {
    branchId: Number(raw[0]),
    sampleIndex: Number(raw[1]),
    rawModeIndex: Number(raw[2]),
  };
}

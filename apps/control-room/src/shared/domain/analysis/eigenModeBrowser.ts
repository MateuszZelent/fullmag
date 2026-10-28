import type { FrequencyDomainJsonArtifactResource, FrequencyDomainManifestResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { buildEigenSpectrumChartModel, buildEigenModeSelectionRef, frequencyDomainManifestPayload, frequencyDomainResultContextFromManifest, frequencyDomainEquilibriumIdForSample } from "./frequencyDomainChartModels";
import { formatModeWavevector, modeResultLabel } from "./modeResultPresentation";
import { formatFrequencyHz } from "./frequencyUnits";

export const MODE_PICKER_PAGE_SIZE = 32;
export interface ModeBrowserItem { key: string; frequencyLabel: string; selection: Selection }
export interface ModeBrowserSample { index: number; label: string; modes: ModeBrowserItem[] }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const vector = (value: unknown): [number, number, number] | undefined => Array.isArray(value) && value.length === 3 && value.every(v => typeof v === "number" && Number.isFinite(v)) ? value as [number, number, number] : undefined;

/** Build an owner-bound, per-sample index once per artifact revision. Labels never act as IDs. */
export function buildEigenModeBrowser(resource: FrequencyDomainJsonArtifactResource | null | undefined, manifest: FrequencyDomainManifestResource | null | undefined) {
  const spectrumModel = buildEigenSpectrumChartModel(resource);
  const context = frequencyDomainResultContextFromManifest(frequencyDomainManifestPayload(manifest), { runId: resource?.run_id, stageId: resource?.stage_id });
  const rawVectors = new Map<string, [number, number, number]>();
  const pathCoordinates = new Map<number, number>();
  const samples = record(resource?.payload).samples;
  if (Array.isArray(samples)) for (const rawSample of samples) {
    const sample = record(rawSample);
    if (typeof sample.sample_index === "number" && typeof sample.path_s === "number" && Number.isFinite(sample.path_s)) {
      pathCoordinates.set(sample.sample_index, sample.path_s);
    }
    if (!Array.isArray(sample.modes)) continue;
    for (const rawMode of sample.modes) {
      const mode = record(rawMode);
      const k = vector(mode.k_vector ?? sample.k_vector);
      if (k) rawVectors.set(`${sample.sample_index}:${mode.raw_mode_index ?? mode.index}`, k);
    }
  }
  const grouped = new Map<number, ModeBrowserSample>();
  for (const point of spectrumModel.points) {
    const key = `${point.sampleIndex}:${point.rawModeIndex}`;
    const k = rawVectors.get(key) ?? (context.kSampling?.kind === "single" ? vector(context.kSampling.vectorRadPerM) : undefined);
    const nodeId = `results:mode-browser:${resource?.run_id}:${resource?.stage_id}:${key}`;
    const ref = buildEigenModeSelectionRef(point, {
      analysisRunId: context.runId, analysisStageId: context.stageId, artifactRevision: resource?.revision,
      equilibriumId: frequencyDomainEquilibriumIdForSample(context, point.sampleIndex),
      wavevectorKf: k, nodeId, representation: "complex-vector-xyz", studyProduct: "modal_eigen",
      kContextKind: context.classification?.kContext.kind,
      kPathCoordinateRadPerM: pathCoordinates.get(point.sampleIndex),
    });
    const selection: Selection = { kind: "results.eigen.mode", moduleSource: "inspector", nodeId, objectId: null, label: modeResultLabel(k, point.frequencyHz), ref };
    let group = grouped.get(point.sampleIndex);
    if (!group) { group = { index: point.sampleIndex, label: k ? formatModeWavevector(k) : `Sample ${point.sampleIndex} · wavevector not published`, modes: [] }; grouped.set(point.sampleIndex, group); }
    group.modes.push({ key, frequencyLabel: formatFrequencyHz(point.frequencyHz), selection });
  }
  for (const group of grouped.values()) {
    group.modes.sort((a,b) => (a.selection.ref?.type === "frequency-domain" ? a.selection.ref.frequencyHz ?? 0 : 0) - (b.selection.ref?.type === "frequency-domain" ? b.selection.ref.frequencyHz ?? 0 : 0));
    const duplicates = new Map<string, number>();
    for (const mode of group.modes) duplicates.set(mode.frequencyLabel, (duplicates.get(mode.frequencyLabel) ?? 0) + 1);
    for (const mode of group.modes) if ((duplicates.get(mode.frequencyLabel) ?? 0) > 1) mode.frequencyLabel += ` · ID ${mode.key}`;
  }
  return { spectrumModel, samples: [...grouped.values()].sort((a,b)=>a.index-b.index) };
}

export function modePickerPage<T extends { label: string; value: string }>(items: readonly T[], search: string, page: number) {
  const filtered = items.filter(item => item.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / MODE_PICKER_PAGE_SIZE));
  const current = Math.max(0, Math.min(page, pages - 1));
  return { items: filtered.slice(current * MODE_PICKER_PAGE_SIZE, (current + 1) * MODE_PICKER_PAGE_SIZE), pages, current, count: filtered.length };
}

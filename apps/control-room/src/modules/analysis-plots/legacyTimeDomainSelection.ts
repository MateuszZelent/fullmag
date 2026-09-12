import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import {
  ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
  ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
} from "@/kernel/api/apiPaths";

import type { DynamicStructureFactorPointSelection } from "./dynamicStructureFactorModel";
import type { SpinWaveGammaFeatureSelection } from "./spinWaveGammaModel";

export type LegacyTimeDomainSelectionRef = Extract<
  SelectionRef,
  { type: "frequency-domain" }
>;

export type LegacyTimeDomainSelectionPatch = {
  kind: string;
  label: string;
  nodeId: string;
  objectId: null;
  ref: LegacyTimeDomainSelectionRef;
};

export function legacyTimeDomainSelectionPatch(
  ref: LegacyTimeDomainSelectionRef,
  fallbackLabel: string,
): LegacyTimeDomainSelectionPatch {
  return {
    kind: ref.kind,
    label: ref.pointId ?? ref.sampleId ?? fallbackLabel,
    nodeId: ref.nodeId,
    objectId: null,
    ref,
  };
}

export function legacyGammaFeatureSelectionRef(
  selection: SpinWaveGammaFeatureSelection,
  artifactRevision: string,
): LegacyTimeDomainSelectionRef | null {
  if (
    !Number.isFinite(selection.frequencyHz) ||
    !Number.isInteger(selection.peakIndex) ||
    selection.peakIndex < 0
  ) {
    return null;
  }
  return createLegacySelection({
    artifactPath: ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
    artifactRevision,
    frequencyHz: selection.frequencyHz,
    frequencyIndex: selection.peakIndex,
    kind: "results.time_domain.spectral_feature",
    itemId: selection.itemId,
    sampleId: selection.sampleId,
    studyProduct: "time_domain_spectrum",
  });
}

export function legacyDsfPointSelectionRef(
  selection: DynamicStructureFactorPointSelection,
  artifactRevision: string,
): LegacyTimeDomainSelectionRef | null {
  if (
    !Number.isFinite(selection.frequencyHz) ||
    !Number.isFinite(selection.kRadPerM) ||
    !Number.isInteger(selection.frequencyIndex) ||
    selection.frequencyIndex < 0 ||
    !Number.isInteger(selection.wavevectorIndex) ||
    selection.wavevectorIndex < 0
  ) {
    return null;
  }
  const base = createLegacySelection({
    artifactPath: ANALYSIS_DYNAMIC_STRUCTURE_FACTOR_V1_PATH,
    artifactRevision,
    frequencyHz: selection.frequencyHz,
    frequencyIndex: selection.frequencyIndex,
    kind: "results.time_domain.dsf_point",
    itemId: selection.itemId,
    sampleId: selection.sampleId,
    studyProduct: "dynamic_structure_factor",
  });
  return base
    ? {
        ...base,
        kContextKind: "k_path",
        kPathCoordinateRadPerM: selection.kRadPerM,
      }
    : null;
}

function createLegacySelection({
  artifactPath,
  artifactRevision,
  frequencyHz,
  frequencyIndex,
  itemId,
  kind,
  sampleId,
  studyProduct,
}: {
  artifactPath: string;
  artifactRevision: string;
  frequencyHz: number;
  frequencyIndex: number;
  itemId: string;
  kind: string;
  sampleId: string;
  studyProduct: string;
}): LegacyTimeDomainSelectionRef | null {
  const revision = artifactRevision.trim();
  if (!revision || !itemId.trim() || !sampleId.trim()) return null;
  return {
    artifactPath,
    artifactRevision: revision,
    availability: "partial",
    executionState: "completed",
    frequencyHz,
    frequencyIndex,
    kind,
    nodeId: `analysis:legacy:time-domain:${encodeURIComponent(itemId)}`,
    pointId: itemId,
    resourceRef: artifactPath,
    resourceState: "ready",
    sampleId,
    sampleIndex: 0,
    source: "time-domain-response",
    studyProduct,
    type: "frequency-domain",
  };
}

import type { InspectorMetadataItem } from "../../inspectorDescriptor";
import type { EigenSpectrumPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";

export type FmrModalSpectrumTrust = "partial" | "qualified" | "unknown";

export interface FmrModalModeRow {
  fieldAvailable: boolean;
  fieldId: string | null;
  fieldResourceKey: string | null;
  frequencyHz: number;
  modeIndex: number;
  modeKey: string;
  point: EigenSpectrumPoint;
  sampleIndex: number;
}

export interface FmrModalSpectrumViewModel {
  canPlotSelectedMode: boolean;
  modes: readonly FmrModalModeRow[];
  provenance: readonly InspectorMetadataItem[];
  selectedModeKey: string | null;
  trust: FmrModalSpectrumTrust;
}

export function buildFmrModalSpectrumViewModel({
  calculationMode,
  points,
  resourceKey,
  selectedModeKey = null,
  status,
}: {
  calculationMode: string;
  points: readonly EigenSpectrumPoint[];
  resourceKey: string;
  selectedModeKey?: string | null;
  status: string;
}): FmrModalSpectrumViewModel {
  const modes = points.map((point) => {
    const fieldAvailable = Boolean(point.modeFieldId && point.modeFieldResourceKey);
    return {
      fieldAvailable,
      fieldId: point.modeFieldId,
      fieldResourceKey: point.modeFieldResourceKey,
      frequencyHz: point.frequencyHz,
      modeIndex: point.rawModeIndex,
      modeKey: `${point.sampleIndex}:${point.rawModeIndex}`,
      point,
      sampleIndex: point.sampleIndex,
    };
  });
  const selectedMode = modes.find((mode) => mode.modeKey === selectedModeKey) ?? null;
  const trust = status === "error" || status === "unsupported"
    ? "unknown"
    : modes.length === 0
      ? "unknown"
      : modes.every((mode) => mode.fieldAvailable)
        ? "qualified"
        : "partial";

  return {
    canPlotSelectedMode: Boolean(selectedMode?.fieldAvailable),
    modes,
    provenance: [
      { label: "Calculation mode", value: calculationMode },
      { label: "Spectrum resource", value: resourceKey },
      { label: "Resource status", value: status },
    ],
    selectedModeKey,
    trust,
  };
}

import type { AnalysisResultItemKind } from "@/shared/domain/analysis/results";
import type { AnalysisResultProjectionSelection } from "./components/AnalysisResultProjectionSurface";

export function resultProjectionSelectionFromLegacyPoint(selection: {
  itemId: string;
  itemKind: AnalysisResultItemKind;
  ordinal: number;
  sampleId: string;
}): AnalysisResultProjectionSelection {
  return {
    branchId: null,
    itemId: selection.itemId,
    itemKind: selection.itemKind,
    ordinal: selection.ordinal,
    sampleId: selection.sampleId,
  };
}

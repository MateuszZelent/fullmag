import type { SavedFieldPresentation } from "@/kernel/visualization/ObjectVisualizationController";
import { selectionRefEquals, type PinnedMaterializedDatasetSelectionRef } from "@/kernel/selection/selectionTypes";

export function savedFieldPresentationForDataset(presentation: SavedFieldPresentation | null, ref: PinnedMaterializedDatasetSelectionRef): SavedFieldPresentation | null {
  return presentation && selectionRefEquals(presentation.selection, ref) ? presentation : null;
}

import type { PinnedMaterializedDatasetSelectionRef, Selection } from "@/kernel/selection/selectionTypes";

export function materializedDatasetSelection(
  selection: Selection,
): PinnedMaterializedDatasetSelectionRef | null {
  return selection.ref?.type === "materialized-dataset" ? selection.ref : null;
}

export function materializedDatasetSelectionMatchesProject(
  ref: PinnedMaterializedDatasetSelectionRef,
  activeProjectId: string | null,
): boolean {
  return activeProjectId === ref.projectId;
}

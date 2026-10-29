import type { SelectionController } from "../selection/SelectionController";
import type { ModuleId } from "../types";
import type { ObjectVisualizationController } from "./ObjectVisualizationController";
import type { MaterializedDatasetResource } from "../api/apiTypes";
import type { PinnedMaterializedDatasetSelectionRef } from "../selection/selectionTypes";

export function materializedDatasetSelectionMatches(
  ref: PinnedMaterializedDatasetSelectionRef,
  data: MaterializedDatasetResource,
): boolean {
  return (
    data.project_id === ref.projectId &&
    data.run_id === ref.runId &&
    data.solution_set_id === ref.solutionSetId &&
    data.containing_solution_revision === ref.containingRevision &&
    data.member_id === ref.memberId &&
    data.artifact_id === ref.artifactId &&
    data.manifest_object_ref === ref.manifestObjectRef &&
    data.sample_id === ref.sampleId &&
    data.item_id === ref.itemId &&
    data.field_id === ref.fieldId &&
    data.dataset.dataset_id === ref.datasetId &&
    data.dataset.revision === ref.datasetRevision
  );
}


/** A rejected dirty-selection transition must preserve the visible saved field. */
export function returnToCurrentFieldView(
  visualization: Pick<ObjectVisualizationController, "clearSavedFieldPresentation">,
  selection: Pick<SelectionController, "get" | "clear">,
  source: ModuleId,
): boolean {
  if (selection.get().ref?.type === "materialized-dataset") {
    selection.clear(source);
    if (selection.get().ref?.type === "materialized-dataset") return false;
  }
  visualization.clearSavedFieldPresentation();
  return true;
}

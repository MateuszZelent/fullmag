import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";
import { pinnedMaterializedDatasetSelectionRef } from "@/kernel/selection/selectionTypes";

import {
  materializedDatasetSelectionMatches,
  materializedDatasetSelectionMatchesProject,
} from "./MaterializedDatasetInspectorPanel";

const ref = pinnedMaterializedDatasetSelectionRef({
  artifactId: "materialized-dataset-artifact",
  containingRevision: "9",
  datasetId: "dataset:m",
  datasetRevision: "1",
  fieldId: "m",
  itemId: "item:0",
  manifestObjectRef: "a".repeat(64),
  memberId: "member:0",
  projectId: "project",
  runId: "run",
  sampleId: "sample:0",
  solutionSetId: "solution",
});

const data = {
  artifact_id: ref.artifactId,
  containing_solution_revision: ref.containingRevision,
  dataset: { dataset_id: ref.datasetId, revision: ref.datasetRevision },
  field_id: ref.fieldId,
  item_id: ref.itemId,
  manifest_object_ref: ref.manifestObjectRef,
  member_id: ref.memberId,
  project_id: ref.projectId,
  run_id: ref.runId,
  sample_id: ref.sampleId,
  solution_set_id: ref.solutionSetId,
} as MaterializedDatasetResource;

describe("materialized dataset inspector identity", () => {
  it("accepts the exact selected manifest root and semantic identity", () => {
    expect(materializedDatasetSelectionMatches(ref, data)).toBe(true);
  });

  it("rejects a response from another manifest root or dataset revision", () => {
    expect(
      materializedDatasetSelectionMatches(ref, {
        ...data,
        manifest_object_ref: "b".repeat(64),
      }),
    ).toBe(false);
    expect(
      materializedDatasetSelectionMatches(ref, {
        ...data,
        dataset: { ...data.dataset, revision: "2" },
      }),
    ).toBe(false);
  });

  it("does not read a pinned dataset while another project is active", () => {
    expect(materializedDatasetSelectionMatchesProject(ref, "project")).toBe(true);
    expect(materializedDatasetSelectionMatchesProject(ref, "other-project")).toBe(false);
    expect(materializedDatasetSelectionMatchesProject(ref, null)).toBe(false);
  });
});

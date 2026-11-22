import { describe, expect, it } from "vitest";

import { pinnedMaterializedDatasetSelectionRef } from "@/kernel/selection/selectionTypes";

import { materializedDatasetSelectionMatchesProject } from "./MaterializedDatasetInspectorPanel.model";

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

describe("materialized dataset inspector identity", () => {
  it("does not read a pinned dataset while another project is active", () => {
    expect(materializedDatasetSelectionMatchesProject(ref, "project")).toBe(true);
    expect(materializedDatasetSelectionMatchesProject(ref, "other-project")).toBe(false);
    expect(materializedDatasetSelectionMatchesProject(ref, null)).toBe(false);
  });
});

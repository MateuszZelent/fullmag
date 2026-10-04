import {
  buildPinnedMaterializedDatasetNodeId,
  pinnedMaterializedDatasetSelectionRef,
  selectionRefEquals,
  type PinnedMaterializedDatasetSelectionRef,
} from "./selectionTypes";

const input = {
  artifactId: "materialized-dataset:manifest/one",
  containingRevision: "18446744073709551615",
  datasetId: "dataset:magnetization",
  datasetRevision: "7",
  fieldId: "m",
  itemId: "item/0",
  manifestObjectRef: "a".repeat(64),
  memberId: "member:stage/1",
  projectId: "project/demo",
  runId: "run-1",
  sampleId: "sample/0",
  solutionSetId: "solution/set",
} as const;

function selection(
  overrides: Partial<typeof input> = {},
): PinnedMaterializedDatasetSelectionRef {
  return pinnedMaterializedDatasetSelectionRef({ ...input, ...overrides });
}

describe("pinned materialized dataset selection", () => {
  it("builds a collision-free node identity from every pinned field", () => {
    const first = selection();
    const changed = selection({ manifestObjectRef: "b".repeat(64) });

    expect(first.nodeId).toBe(buildPinnedMaterializedDatasetNodeId(input));
    expect(first.nodeId).not.toBe(changed.nodeId);
    expect(first.nodeId).toContain("project=project%2Fdemo");
    expect(first.nodeId).toContain("manifest=" + "a".repeat(64));
  });

  it("compares all six path identities and materialized field identity", () => {
    const first = selection();
    expect(selectionRefEquals(first, selection())).toBe(true);

    for (const key of Object.keys(input) as Array<keyof typeof input>) {
      const changedInput = {
        ...input,
        [key]: `${input[key]}-changed`,
      } as typeof input;
      expect(selectionRefEquals(first, selection(changedInput))).toBe(false);
    }
  });
});

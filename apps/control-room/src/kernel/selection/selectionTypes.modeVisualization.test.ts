import { describe, expect, it } from "vitest";

import { selectionRefEquals, type SelectionRef } from "./selectionTypes";

type ModeVisualizationRef = Extract<SelectionRef, { type: "mode-visualization" }>;

function modeRef(fieldIds: readonly string[]): ModeVisualizationRef {
  return {
    fieldId: fieldIds[0] ?? "field-a",
    fieldIds,
    kind: "object.mode_visualization.group",
    nodeId: "model:object:film:visualization:mode-visualization:eigen",
    objectId: "film",
    source: "eigen-mode",
    type: "mode-visualization",
    visualizationTargetId: "mode:film:eigen-mode:field-a",
  } as ModeVisualizationRef;
}

describe("mode visualization selection identity", () => {
  it("includes the canonical ordered field list in equality", () => {
    const first = modeRef(["field-a", "field-b"]);

    expect(selectionRefEquals(first, modeRef(["field-a", "field-b"]))).toBe(true);
    expect(selectionRefEquals(first, modeRef(["field-a", "field-c"]))).toBe(false);
    expect(selectionRefEquals(first, modeRef(["field-b", "field-a"]))).toBe(false);
  });

  it("includes result provenance in overlay selection equality", () => {
    const first = {
      ...modeRef(["field-a"]),
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactRevision: 7,
      equilibriumId: "eq-1",
      kContextKind: "gamma",
      resourceRef: "data/fields/field-a",
      studyProduct: "modal_eigen",
    } satisfies ModeVisualizationRef;

    expect(selectionRefEquals(first, { ...first })).toBe(true);
    for (const change of [
      { analysisRunId: "run-2" },
      { analysisStageId: "stage-2" },
      { artifactRevision: 8 },
      { equilibriumId: "eq-2" },
      { kContextKind: "fixed_k" },
      { resourceRef: "data/fields/field-b" },
      { studyProduct: "driven_response" },
    ]) {
      expect(selectionRefEquals(first, { ...first, ...change })).toBe(false);
    }
  });

  it("includes frequency-domain provenance in result selection equality", () => {
    const first: Extract<SelectionRef, { type: "frequency-domain" }> = {
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactRevision: 7,
      equilibriumId: "eq-1",
      fieldId: "field-a",
      kContextKind: "gamma",
      kind: "results.eigen.mode",
      nodeId: "results:run-1:mode-1",
      resourceRef: "data/fields/field-a",
      studyProduct: "modal_eigen",
      type: "frequency-domain",
    };

    expect(selectionRefEquals(first, { ...first })).toBe(true);
    expect(selectionRefEquals(first, { ...first, artifactRevision: 8 })).toBe(false);
    expect(selectionRefEquals(first, { ...first, equilibriumId: "eq-2" })).toBe(false);
    expect(selectionRefEquals(first, { ...first, kContextKind: "fixed_k" })).toBe(false);
    expect(
      selectionRefEquals(first, { ...first, studyProduct: "driven_response" }),
    ).toBe(false);
  });
});

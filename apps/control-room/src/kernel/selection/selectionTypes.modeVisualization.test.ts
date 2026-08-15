import { describe, expect, it } from "vitest";

import { selectionRefEquals, type SelectionRef } from "./selectionTypes";

type ModeVisualizationRef = Extract<SelectionRef, { type: "mode-visualization" }>;

function modeRef(fieldId = "field-a"): ModeVisualizationRef {
  return {
    fieldId,
    kind: "object.mode_visualization",
    nodeId: "model:object:film:visualization:mode-visualization",
    objectId: "film",
    source: "eigen-mode",
    type: "mode-visualization",
    visualizationTargetId: "mode:film:eigen-mode:field-a",
  } as ModeVisualizationRef;
}

describe("mode visualization selection identity", () => {
  it("uses the exact canonical field in equality", () => {
    const first = modeRef("field-a");

    expect(selectionRefEquals(first, modeRef("field-a"))).toBe(true);
    expect(selectionRefEquals(first, modeRef("field-b"))).toBe(false);
  });

  it("includes result provenance in overlay selection equality", () => {
    const first = {
      ...modeRef("field-a"),
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactRevision: 7,
      equilibriumId: "eq-1",
      kContextKind: "gamma",
      resourceRef: "data/fields/field-a",
      studyProduct: "modal_eigen",
    } satisfies ModeVisualizationRef;

    expect(selectionRefEquals(first, { ...first })).toBe(true);
    const changes: Partial<ModeVisualizationRef>[] = [
      { analysisRunId: "run-2" },
      { analysisStageId: "stage-2" },
      { artifactRevision: 8 },
      { equilibriumId: "eq-2" },
      { kContextKind: "fixed_k" },
      { resourceRef: "data/fields/field-b" },
      { studyProduct: "driven_response" },
    ];
    for (const change of changes) {
      expect(selectionRefEquals(first, { ...first, ...change })).toBe(false);
    }
  });

  it("includes frequency-domain provenance in result selection equality", () => {
    const first: Extract<SelectionRef, { type: "frequency-domain" }> = {
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactRevision: 7,
      availability: "available",
      contractGap: null,
      equilibriumId: "eq-1",
      executionState: "completed",
      fieldId: "field-a",
      frequencyHz: 12.5e9,
      kContextKind: "gamma",
      kind: "results.resonance.modal.mode",
      nodeId: "results:run-1:mode-1",
      representation: "complex-vector-xyz",
      resourceRef: "data/fields/field-a",
      resourceState: "ready",
      source: "eigen-mode",
      studyProduct: "modal_eigen",
      type: "frequency-domain",
    };

    expect(selectionRefEquals(first, { ...first })).toBe(true);
    expect(selectionRefEquals(first, { ...first, artifactRevision: 8 })).toBe(false);
    expect(selectionRefEquals(first, { ...first, availability: "partial" })).toBe(false);
    expect(selectionRefEquals(first, { ...first, contractGap: "missing drive evidence" })).toBe(false);
    expect(selectionRefEquals(first, { ...first, equilibriumId: "eq-2" })).toBe(false);
    expect(selectionRefEquals(first, { ...first, kContextKind: "fixed_k" })).toBe(false);
    expect(selectionRefEquals(first, { ...first, frequencyHz: 13e9 })).toBe(false);
    expect(selectionRefEquals(first, { ...first, representation: "other" })).toBe(false);
    expect(selectionRefEquals(first, { ...first, executionState: "running" })).toBe(false);
    expect(selectionRefEquals(first, { ...first, resourceState: "stale" })).toBe(false);
    expect(
      selectionRefEquals(first, { ...first, studyProduct: "driven_response" }),
    ).toBe(false);
  });
});

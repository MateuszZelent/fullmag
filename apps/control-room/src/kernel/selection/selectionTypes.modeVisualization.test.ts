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
});

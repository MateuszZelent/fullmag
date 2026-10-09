import { describe, expect, it } from "vitest";

import { modeVisualizationDefinitionFromSelection, pinnedModeVisualizationId } from "./postprocessingDefinitions";

function modeSelection(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    kind,
    label: "Mode 1",
    ref: {
      analysisRunId: "run-1",
      analysisStageId: "eigen-dispersion",
      artifactRevision: 7,
      fieldId: "analysis:eigen:sample-0006:mode-0001",
      frequencyHz: 12.025103e9,
      kind,
      nodeId: "node",
      type: "frequency-domain" as const,
      ...overrides,
    },
  };
}

describe("pinned mode visualization definitions", () => {
  it("store only published identities of the selected mode", () => {
    const result = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k") as never,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition).toMatchObject({
      definition_id: pinnedModeVisualizationId("analysis.dispersion", "analysis:eigen:sample-0006:mode-0001"),
      definition_schema: "analysis.dispersion.mode_visualization.v1",
      label: "Mode 1 · 12.0251 GHz",
      module_id: "analysis.dispersion",
      node_kind: "analysis.dispersion.mode_visualization",
      data_ref: {
        dataset_id: "eigen-dispersion",
        dataset_revision: "7",
        field_id: "analysis:eigen:sample-0006:mode-0001",
        run_id: "run-1",
      },
    });
  });

  it("routes resonance modes to the resonance module", () => {
    const result = modeVisualizationDefinitionFromSelection(
      modeSelection("results.resonance.modal.mode") as never,
    );
    expect(result.ok && result.definition.node_kind).toBe("analysis.resonance.mode_visualization");
  });

  it("refuses selections without a field or a published identity", () => {
    expect(modeVisualizationDefinitionFromSelection(null).ok).toBe(false);
    expect(
      modeVisualizationDefinitionFromSelection(
        modeSelection("results.dispersion.modal.mode_at_k", { fieldId: undefined }) as never,
      ).ok,
    ).toBe(false);
    expect(
      modeVisualizationDefinitionFromSelection(
        modeSelection("results.dispersion.modal.mode_at_k", { artifactRevision: undefined }) as never,
      ).ok,
    ).toBe(false);
    expect(modeVisualizationDefinitionFromSelection(modeSelection("object.visualization") as never).ok).toBe(false);
  });
});

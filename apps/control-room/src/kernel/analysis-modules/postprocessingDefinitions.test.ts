import { describe, expect, it } from "vitest";

import {
  modeVisualizationOwnerMatch,
  modeVisualizationDefinitionFromSelection,
  pinnedModeVisualizationId,
  sameModeVisualizationOwner,
} from "./postprocessingDefinitions";

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
      definition_id: pinnedModeVisualizationId("analysis.dispersion", {
        run_id: "run-1",
        dataset_id: "eigen-dispersion",
        dataset_revision: "7",
        field_id: "analysis:eigen:sample-0006:mode-0001",
      }),
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

  it("keys pins by full published owner identity without delimiter collisions", () => {
    const base = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k") as never,
    );
    const otherRun = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", { analysisRunId: "run-2" }) as never,
    );
    const otherStage = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", {
        analysisStageId: "another-dataset",
      }) as never,
    );
    const otherRevision = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", { artifactRevision: 8 }) as never,
    );
    const otherSample = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", { sampleId: "sample-7" }) as never,
    );
    const otherItem = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", { modeId: "mode-7" }) as never,
    );
    const delimiterLeft = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", {
        analysisRunId: "run:dataset",
        analysisStageId: "revision",
        artifactRevision: "x:y",
        fieldId: "field",
      }) as never,
    );
    const delimiterRight = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", {
        analysisRunId: "run",
        analysisStageId: "dataset:revision",
        artifactRevision: "x:y",
        fieldId: "field",
      }) as never,
    );

    expect(
      base.ok &&
        otherRun.ok &&
        otherStage.ok &&
        otherRevision.ok &&
        otherSample.ok &&
        otherItem.ok &&
        delimiterLeft.ok &&
        delimiterRight.ok,
    ).toBe(true);
    if (
      !base.ok ||
      !otherRun.ok ||
      !otherStage.ok ||
      !otherRevision.ok ||
      !otherSample.ok ||
      !otherItem.ok ||
      !delimiterLeft.ok ||
      !delimiterRight.ok
    ) {
      return;
    }
    const baseId = base.definition.definition_id;
    expect(otherRun.definition.definition_id).not.toBe(baseId);
    expect(otherStage.definition.definition_id).not.toBe(baseId);
    expect(otherRevision.definition.definition_id).not.toBe(baseId);
    expect(otherSample.definition.definition_id).not.toBe(baseId);
    expect(otherItem.definition.definition_id).not.toBe(baseId);
    expect(delimiterLeft.definition.definition_id).not.toBe(
      delimiterRight.definition.definition_id,
    );
    expect(otherSample.definition.data_ref).toMatchObject({ sample_id: "sample-7" });
    expect(otherItem.definition.data_ref).toMatchObject({ item_id: "mode-7" });
  });

  it("recognizes historical field-only IDs by full stored owner data_ref", () => {
    const result = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", {
        sampleId: "sample-6",
        modeId: "mode-1",
      }) as never,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const historical = {
      ...result.definition,
      definition_id: "analysis.dispersion:mode-visualization:analysis:eigen:sample-0006:mode-0001",
    };
    expect(sameModeVisualizationOwner(historical, result.definition)).toBe(true);
    expect(modeVisualizationOwnerMatch(historical, result.definition)).toBe("exact");
    expect(sameModeVisualizationOwner(historical, {
      ...result.definition,
      data_ref: { ...result.definition.data_ref, dataset_revision: "8" },
    })).toBe(false);
    expect(modeVisualizationOwnerMatch({
      ...historical,
      data_ref: {
        ...historical.data_ref,
        sample_id: undefined,
        item_id: undefined,
      },
    }, result.definition)).toBe("compatible-incomplete");
    expect(sameModeVisualizationOwner(historical, {
      ...result.definition,
      data_ref: { ...result.definition.data_ref, item_id: "mode-2" },
    })).toBe(false);
    expect(modeVisualizationOwnerMatch({
      ...historical,
      data_ref: { ...historical.data_ref, item_id: "mode-2" },
    }, result.definition)).toBe("different");
    expect(modeVisualizationOwnerMatch({
      ...historical,
      data_ref: {
        ...historical.data_ref,
        sample_id: undefined,
        item_id: "mode-2",
      },
    }, result.definition)).toBe("different");
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

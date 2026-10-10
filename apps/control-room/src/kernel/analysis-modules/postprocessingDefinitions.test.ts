import { describe, expect, it } from "vitest";

import { MAX_REFERENCE_POINTS } from "@/shared/domain/analysis/referenceImport";

import {
  IMPORTED_REFERENCE_SCHEMA,
  importedReferenceDefinition,
  importedReferencePoints,
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

describe("imported dispersion reference definitions", () => {
  const baseInput = {
    dataset: { artifactRevision: 7, runId: "run-1", stageId: "eigen-dispersion" },
    fileName: "reference.csv",
    label: "Reference",
    points: [[3, 9], [-1, 2]] as const,
    sourceUnits: { frequency: "GHz", path: "rad/um" } as const,
  };

  it("preserves every accepted SI pair through definition construction and readback", () => {
    const definition = importedReferenceDefinition(baseInput);

    expect(definition.definition_schema).toBe(IMPORTED_REFERENCE_SCHEMA);
    expect(importedReferencePoints(definition)).toEqual([[3, 9], [-1, 2]]);
  });

  it("accepts the exact point limit and rejects an oversized constructor input before copying", () => {
    const points = Array.from({ length: MAX_REFERENCE_POINTS }, (_, index) => [index, index] as const);
    const definition = importedReferenceDefinition({ ...baseInput, points });

    expect(importedReferencePoints(definition)).toHaveLength(MAX_REFERENCE_POINTS);
    expect(() => importedReferenceDefinition({
      ...baseInput,
      points: [...points, [MAX_REFERENCE_POINTS, MAX_REFERENCE_POINTS] as const],
    })).toThrow(/at most/);
  });

  it("rejects malformed stored point sets as a whole instead of dropping individual rows", () => {
    const definition = importedReferenceDefinition(baseInput);
    const malformed = {
      ...definition,
      settings: { ...definition.settings, points: [[0, 1], [2, "3"], [4, 5]] },
    };
    const oversized = {
      ...definition,
      settings: {
        ...definition.settings,
        points: Array.from({ length: MAX_REFERENCE_POINTS + 1 }, (_, index) => [index, index]),
      },
    };
    const unsupportedUnits = {
      ...definition,
      settings: { ...definition.settings, source_units: { frequency: "Hz", path: "m" } },
    };

    expect(importedReferencePoints(malformed)).toBeNull();
    expect(importedReferencePoints(oversized)).toBeNull();
    expect(importedReferencePoints(unsupportedUnits)).toBeNull();
  });

  it.each([
    ["non-finite SI value", { points: [[0, 1], [2, Number.NaN]] }],
    ["unsupported unit", { sourceUnits: { frequency: "kHz", path: "rad/m" } }],
    ["non-finite published revision", { dataset: { artifactRevision: Number.NaN, runId: "run-1", stageId: "stage-1" } }],
  ])("rejects %s in a direct constructor call", (_description, overrides) => {
    expect(() => importedReferenceDefinition({ ...baseInput, ...overrides } as never)).toThrow();
  });
});

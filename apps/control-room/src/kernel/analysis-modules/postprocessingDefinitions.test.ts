import { describe, expect, it, vi } from "vitest";

import { MAX_REFERENCE_POINTS } from "@/shared/domain/analysis/referenceImport";

import type { ImportedReferenceInput } from "./postprocessingDefinitions";
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
      datasetId: "catalog:eigen-dispersion",
      datasetRevision: "catalog-revision-7",
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
        dataset_id: "catalog:eigen-dispersion",
        dataset_revision: "catalog-revision-7",
        field_id: "analysis:eigen:sample-0006:mode-0001",
      }),
      definition_schema: "analysis.dispersion.mode_visualization.v1",
      label: "Mode 1 · 12.0251 GHz",
      module_id: "analysis.dispersion",
      node_kind: "analysis.dispersion.mode_visualization",
      data_ref: {
        dataset_id: "catalog:eigen-dispersion",
        dataset_revision: "catalog-revision-7",
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
    const otherDataset = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", {
        datasetId: "catalog:another-dataset",
      }) as never,
    );
    const otherDatasetRevision = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", { datasetRevision: "catalog-revision-8" }) as never,
    );
    const differentLegacyStage = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", {
        analysisStageId: "another-stage",
        artifactRevision: 8,
      }) as never,
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
        datasetId: "revision",
        datasetRevision: "x:y",
        fieldId: "field",
      }) as never,
    );
    const delimiterRight = modeVisualizationDefinitionFromSelection(
      modeSelection("results.dispersion.modal.mode_at_k", {
        analysisRunId: "run",
        analysisStageId: "dataset:revision",
        artifactRevision: "x:y",
        datasetId: "dataset:revision",
        datasetRevision: "x:y",
        fieldId: "field",
      }) as never,
    );

    expect(
      base.ok &&
        otherRun.ok &&
        otherDataset.ok &&
        otherDatasetRevision.ok &&
        differentLegacyStage.ok &&
        otherSample.ok &&
        otherItem.ok &&
        delimiterLeft.ok &&
        delimiterRight.ok,
    ).toBe(true);
    if (
      !base.ok ||
      !otherRun.ok ||
      !otherDataset.ok ||
      !otherDatasetRevision.ok ||
      !differentLegacyStage.ok ||
      !otherSample.ok ||
      !otherItem.ok ||
      !delimiterLeft.ok ||
      !delimiterRight.ok
    ) {
      return;
    }
    const baseId = base.definition.definition_id;
    expect(otherRun.definition.definition_id).not.toBe(baseId);
    expect(otherDataset.definition.definition_id).not.toBe(baseId);
    expect(otherDatasetRevision.definition.definition_id).not.toBe(baseId);
    expect(differentLegacyStage.definition.definition_id).toBe(baseId);
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
        modeSelection("results.dispersion.modal.mode_at_k", {
          datasetId: undefined,
          datasetRevision: undefined,
        }) as never,
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

  it("preserves every accepted SI pair through definition construction and readback", async () => {
    const definition = await importedReferenceDefinition(baseInput);

    expect(definition.definition_schema).toBe(IMPORTED_REFERENCE_SCHEMA);
    expect(importedReferencePoints(definition)).toEqual([[3, 9], [-1, 2]]);
  });

  it("accepts the exact point limit and rejects an oversized constructor input before copying", async () => {
    const points = Array.from({ length: MAX_REFERENCE_POINTS }, (_, index) => [index, index] as const);
    const definition = await importedReferenceDefinition({ ...baseInput, points });

    expect(importedReferencePoints(definition)).toHaveLength(MAX_REFERENCE_POINTS);
    await expect(importedReferenceDefinition({
      ...baseInput,
      points: [...points, [MAX_REFERENCE_POINTS, MAX_REFERENCE_POINTS] as const],
    })).rejects.toThrow(/at most/);
  });

  it("rejects malformed stored point sets as a whole instead of dropping individual rows", async () => {
    const definition = await importedReferenceDefinition(baseInput);
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
  ])("rejects %s in a direct constructor call", async (_description, overrides) => {
    await expect(importedReferenceDefinition({ ...baseInput, ...overrides } as never)).rejects.toThrow();
  });

  it("uses a stable SHA-256 ID for equivalent full payloads and distinguishes changed content", async () => {
    const original = await importedReferenceDefinition(baseInput);
    const equivalent = await importedReferenceDefinition({
      ...baseInput,
      dataset: { ...baseInput.dataset },
      points: baseInput.points.map(([path, frequency]): [number, number] => [path, frequency]),
      sourceUnits: { ...baseInput.sourceUnits },
    });
    const changedLaterPoint = await importedReferenceDefinition({
      ...baseInput,
      points: [[3, 9], [-1, 3]],
    });
    const changedUnits = await importedReferenceDefinition({
      ...baseInput,
      sourceUnits: { ...baseInput.sourceUnits, path: "rad/m" },
    });
    const changedFrequencyUnits = await importedReferenceDefinition({
      ...baseInput,
      sourceUnits: { ...baseInput.sourceUnits, frequency: "Hz" },
    });
    const changedLabel = await importedReferenceDefinition({ ...baseInput, label: "Other reference" });
    const changedFileName = await importedReferenceDefinition({ ...baseInput, fileName: "other.csv" });
    const changedOwnerRevision = await importedReferenceDefinition({
      ...baseInput,
      dataset: { ...baseInput.dataset, artifactRevision: 8 },
    });

    expect(original.definition_id).toMatch(/^analysis\.dispersion:reference:sha256:[0-9a-f]{64}$/);
    expect(equivalent.definition_id).toBe(original.definition_id);
    expect(importedReferencePoints(changedLaterPoint)).toEqual([[3, 9], [-1, 3]]);
    expect(importedReferencePoints(changedLaterPoint)).toHaveLength(baseInput.points.length);
    expect(importedReferencePoints(changedLaterPoint)?.[0]).toEqual(baseInput.points[0]);
    for (const changed of [changedLaterPoint, changedUnits, changedFrequencyUnits, changedLabel, changedFileName, changedOwnerRevision]) {
      expect(changed.definition_id).not.toBe(original.definition_id);
    }
  });

  it("hashes and returns the same detached payload snapshot before awaiting SHA-256", async () => {
    const points: [number, number][] = [[3, 9], [-1, 2]];
    const input: ImportedReferenceInput = {
      dataset: { ...baseInput.dataset },
      fileName: baseInput.fileName,
      label: baseInput.label,
      points,
      sourceUnits: { ...baseInput.sourceUnits },
    };
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let resolveStarted!: (data: BufferSource) => void;
    const started = new Promise<BufferSource>((resolve) => { resolveStarted = resolve; });
    let releaseDigest!: () => void;
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const delayedDigest = vi.fn(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      resolveStarted(data);
      await digestGate;
      return originalDigest(algorithm, data);
    });
    vi.stubGlobal("crypto", { subtle: { digest: delayedDigest } });

    try {
      const pending = importedReferenceDefinition(input);
      const digestPayload = await started;
      points[1][1] = 99;
      input.dataset.artifactRevision = 8;
      input.fileName = "mutated.csv";
      input.label = "Mutated label";
      input.sourceUnits.path = "rad/m";
      releaseDigest();
      const definition = await pending;

      const serializedSnapshot = JSON.parse(new TextDecoder().decode(digestPayload)) as Record<string, unknown>;
      const { definition_id: _definitionId, ...persistedPayload } = definition;
      const digest = await originalDigest("SHA-256", digestPayload);
      const expectedContentSha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");

      expect(serializedSnapshot).toMatchObject({
        definition_schema: IMPORTED_REFERENCE_SCHEMA,
        label: "Reference",
        module_id: "analysis.dispersion",
        data_ref: { run_id: "run-1", dataset_id: "eigen-dispersion", dataset_revision: "7" },
        settings: {
          file_name: "reference.csv",
          points: [[3, 9], [-1, 2]],
          source_units: { frequency: "GHz", path: "rad/um" },
        },
      });
      expect(persistedPayload).toEqual(serializedSnapshot);
      expect(definition.definition_id).toBe(`analysis.dispersion:reference:sha256:${expectedContentSha256}`);
    } finally {
      releaseDigest();
      vi.unstubAllGlobals();
    }
  });
});

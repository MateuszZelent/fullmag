import { describe, expect, it, vi } from "vitest";

import type {
  AnalysisResultDatasetCatalogResource,
  AnalysisResultDatasetManifestResource,
  AnalysisResultItemPageResource,
  AnalysisResultPageQuery,
  AnalysisResultSpectralItemSummary,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { AuthoringHistoryController } from "@/kernel/authoring/AuthoringHistoryController";
import { resultDatasetItemSelection } from "@/modules/results-navigator/ResultDatasetBrowser";

import {
  ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import { MAX_REFERENCE_POINTS } from "@/shared/domain/analysis/referenceImport";

import {
  IMPORT_DISPERSION_REFERENCE_COMMAND,
  PIN_MODE_VISUALIZATION_COMMAND,
  POSTPROCESSING_DEFINITION_COMMANDS,
  UNPIN_POSTPROCESSING_DEFINITION_COMMAND,
} from "./postprocessingCommandContributions";

const fieldId = "analysis:eigen:sample-0001:mode-0000";

function modeSelection(includeCanonicalDatasetIdentity = true) {
  return {
    kind: "results.dispersion.modal.mode_at_k",
    label: "Mode 1",
    ref: {
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactRevision: 7,
      kind: "results.dispersion.modal.mode_at_k",
      nodeId: "selected-mode",
      ...(includeCanonicalDatasetIdentity
        ? { datasetId: "catalog:eigen-dispersion", datasetRevision: "catalog-revision-7" }
        : {}),
      fieldId,
      sampleId: "sample-0001",
      modeId: "mode-0000",
      type: "frequency-domain" as const,
    },
  };
}

function savedModeDefinition(
  datasetRevision: string,
  optionalOwner: { sampleId?: string; itemId?: string } = {
    sampleId: "sample-0001",
    itemId: "mode-0000",
  },
) {
  return {
    definition_id: `analysis.dispersion:mode-visualization:${fieldId}`,
    revision: 1,
    module_id: "analysis.dispersion",
    module_version: "0.1.0",
    definition_schema: "analysis.dispersion.mode_visualization.v1",
    node_kind: "analysis.dispersion.mode_visualization",
    label: "Mode 1",
    data_ref: {
      run_id: "run-1",
      dataset_id: "catalog:eigen-dispersion",
      dataset_revision: datasetRevision,
      field_id: fieldId,
      ...(optionalOwner.sampleId !== undefined
        ? { sample_id: optionalOwner.sampleId }
        : {}),
      ...(optionalOwner.itemId !== undefined
        ? { item_id: optionalOwner.itemId }
        : {}),
    },
    settings: { placement: "beside" },
  };
}

function legacyResultsApi() {
  const manifest = {
    run_id: "run-1",
    stage_id: "stage-1",
    dataset_id: "catalog:eigen-dispersion",
    dataset_revision: "catalog-revision-7",
    product_kind: "modal_eigen",
    item_kinds: ["eigen_mode"],
    axes: [{ axis_id: "wavevector", role: "wavevector", cardinality: 2 }],
    capabilities: { fields: true },
    status: "ready",
  } as unknown as AnalysisResultDatasetManifestResource;
  const resultItem = {
    item_id: "mode-0000",
    item_kind: "eigen_mode",
    branch_id: "branch-0001",
    sample_id: "sample-0001",
    frequency_hz: 1.20251e10,
    source_revision: "item-source-revision-99",
    field_ref: {
      field_id: fieldId,
      field_revision: "field-revision-3",
      resource_key: "analysis-result:field:canonical-3",
      status: "ready",
      quantity_id: "m",
      representation: "vector3",
      mesh_ref: {
        mesh_id: "mesh-1",
        mesh_revision: "mesh-revision-2",
        topology_fingerprint: "mesh-topology-2",
      },
    },
  } as unknown as AnalysisResultSpectralItemSummary;
  const datasetCatalog = {
    items: [{
      dataset_id: "catalog:eigen-dispersion",
      dataset_revision: "catalog-revision-7",
      item_count: 1,
      product_kind: "modal_eigen",
      run_id: "run-1",
      sample_count: 1,
      stage_id: "stage-1",
      status: "ready",
      title: "Eigen dispersion",
    }],
    next_cursor: null,
    revision: "catalog-list-revision-1",
    run_id: "run-1",
    schema_version: "analysis-result-dataset-catalog.v1",
    status: "ready",
    total_count: 1,
  } as unknown as AnalysisResultDatasetCatalogResource;
  const itemPage = {
    dataset_id: "catalog:eigen-dispersion",
    dataset_revision: "catalog-revision-7",
    items: [resultItem],
    next_cursor: null,
    run_id: "run-1",
    total_count: 1,
  } as unknown as AnalysisResultItemPageResource;
  const datasets = vi.fn(async (
    _runId: string,
    _query: AnalysisResultPageQuery,
    _options?: { sessionScopeKey?: string; signal?: AbortSignal },
  ) => datasetCatalog);
  const dataset = vi.fn(async (
    _runId: string,
    _datasetId: string,
    _options?: { sessionScopeKey?: string },
  ) => manifest);
  const items = vi.fn(async (
    _runId: string,
    _datasetId: string,
    _query: AnalysisResultPageQuery,
    _options?: { sessionScopeKey?: string; signal?: AbortSignal },
  ) => itemPage);
  const item = vi.fn(async (
    _runId: string,
    _datasetId: string,
    _itemId: string,
    _options?: { sessionScopeKey?: string },
  ) => resultItem);
  return { dataset, datasets, item, items, itemPage, resultItem, manifest, datasetCatalog };
}

function commandContext(
  definitions: readonly ReturnType<typeof savedModeDefinition>[],
  create = vi.fn().mockResolvedValue({
    definition: { label: "Mode 1" },
    scene_revision: 12,
  }),
  authoringHistory?: AuthoringHistoryController,
  selectedMode = modeSelection(),
) {
  const list = vi.fn().mockResolvedValue({ definitions, scene_revision: 11 });
  const results = legacyResultsApi();
  const invalidate = vi.fn();
  return {
    context: {
      api: {
        analysis: {
          results,
          postprocessing: { definitions: { list, create } },
        },
      },
      selection: { get: () => selectedMode },
      resources: { invalidate },
      authoringHistory,
    } as never,
    create,
    ...results,
    invalidate,
    list,
  };
}

function pinCommand() {
  return POSTPROCESSING_DEFINITION_COMMANDS.find(
    (command) => command.id === PIN_MODE_VISUALIZATION_COMMAND,
  );
}

function referenceCommandContext(input: unknown, list = vi.fn().mockResolvedValue({ definitions: [], scene_revision: 11 })) {
  const create = vi.fn();
  const invalidate = vi.fn();
  return {
    context: {
      api: { analysis: { postprocessing: { definitions: { list, create } } } },
      input,
      selection: {
        get: () => ({
          kind: "results.dispersion",
          label: "Dispersion",
          ref: {
            analysisRunId: "run-1",
            analysisStageId: "stage-1",
            artifactRevision: 7,
            type: "frequency-domain" as const,
          },
        }),
      },
      resources: { invalidate },
    } as never,
    create,
    invalidate,
    list,
  };
}

function referenceCommand() {
  return POSTPROCESSING_DEFINITION_COMMANDS.find(
    (command) => command.id === IMPORT_DISPERSION_REFERENCE_COMMAND,
  );
}

describe("pin mode visualization command owner deduplication", () => {
  it("bridges a field without a dataset tuple through canonical Results resources", async () => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([], undefined, undefined, modeSelection(false));

    const result = await command.run(fixture.context);

    expect(result.status).toBe("completed");
    expect(fixture.datasets).toHaveBeenCalledTimes(1);
    expect(fixture.datasets.mock.calls[0]?.[0]).toBe("run-1");
    expect(fixture.datasets.mock.calls[0]?.[1]).toMatchObject({
      product_kind: "modal_eigen",
      stage_id: "stage-1",
      limit: 500,
    });
    expect(fixture.items).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      "catalog:eigen-dispersion",
      {
        has_field: true,
        item_kind: "eigen_mode",
        limit: 50,
        sample_id: "sample-0001",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.dataset).toHaveBeenCalledTimes(2);
    expect(fixture.item).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      "catalog:eigen-dispersion",
      "mode-0000",
      undefined,
    );
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({
          data_ref: {
            run_id: "run-1",
            dataset_id: "catalog:eigen-dispersion",
            dataset_revision: "catalog-revision-7",
            field_id: fieldId,
            sample_id: "sample-0001",
            item_id: "mode-0000",
          },
        }),
      }),
      undefined,
    );
    expect(fixture.invalidate).toHaveBeenCalledTimes(2);
  });

  it("recognizes an existing field-only ID by its complete stored owner", async () => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([savedModeDefinition("catalog-revision-7")]);

    const result = await command.run(fixture.context);

    expect(result).toEqual({
      message: "This mode visualization is already pinned.",
      status: "completed",
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("allows the same field in a different published dataset revision", async () => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([savedModeDefinition("catalog-revision-6")]);
    fixture.create.mockResolvedValue({
      definition: { label: "Mode 1" },
      scene_revision: 12,
    });

    await command.run(fixture.context);

    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        data_ref: expect.objectContaining({
          dataset_id: "catalog:eigen-dispersion",
          dataset_revision: "catalog-revision-7",
          field_id: fieldId,
          run_id: "run-1",
          sample_id: "sample-0001",
          item_id: "mode-0000",
        }),
      }),
    }), undefined);
  });

  it.each([
    ["both optional IDs are missing", {}],
    ["one optional ID is missing", { sampleId: "sample-0001" }],
    ["the other optional ID is missing", { itemId: "mode-0000" }],
  ])("refuses to create a duplicate when a legacy owner is ambiguous: %s", async (_label, owner) => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([savedModeDefinition("catalog-revision-7", owner)]);

    const result = await command.run(fixture.context);

    expect(result).toEqual({
      message:
        "An existing pin and this selection share the same published field owner, but lack enough sample or mode identity to tell whether they are the same mode. Review or remove the existing pin before adding another.",
      status: "failed",
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("keeps an explicit mode conflict distinct despite another missing ID", async () => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([
      savedModeDefinition("catalog-revision-7", { itemId: "mode-other" }),
    ]);
    fixture.create.mockResolvedValue({
      definition: { label: "Mode 1" },
      scene_revision: 12,
    });

    const result = await command.run(fixture.context);

    expect(result.status).toBe("completed");
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expectSceneRevisionInvalidations(fixture.invalidate.mock.calls, 12);
  });
});

type PublishedProductKind = "modal_eigen" | "driven_response";

function publishedDataset(
  productKind: PublishedProductKind,
  wavevectorCardinality: number | null,
  fieldsAvailable = true,
): AnalysisResultDatasetManifestResource {
  const itemKind = productKind === "modal_eigen" ? "eigen_mode" : "driven_frequency_point";
  return {
    run_id: "run-1",
    stage_id: "stage-is-not-dataset",
    dataset_id: "catalog:eigen-dispersion",
    dataset_revision: "catalog-revision-7",
    product_kind: productKind,
    item_kinds: [itemKind],
    axes: wavevectorCardinality === null
      ? [{ axis_id: "frequency", role: "spectral", cardinality: 4 }]
      : [{ axis_id: "wavevector", role: "wavevector", cardinality: wavevectorCardinality }],
    capabilities: { fields: fieldsAvailable },
  } as unknown as AnalysisResultDatasetManifestResource;
}

function publishedItem(
  productKind: PublishedProductKind,
): AnalysisResultSpectralItemSummary {
  const itemKind = productKind === "modal_eigen" ? "eigen_mode" : "driven_frequency_point";
  const fieldRef = {
    field_id: fieldId,
    field_revision: "field-revision-3",
    resource_key: "analysis-result:field:canonical-3",
    status: "ready",
    quantity_id: "m",
    representation: "vector3",
    mesh_ref: {
      mesh_id: "mesh-1",
      mesh_revision: "mesh-revision-2",
      topology_fingerprint: "mesh-topology-2",
    },
  };
  return {
    item_id: "mode-0000",
    item_kind: itemKind,
    branch_id: "branch-0001",
    sample_id: "sample-0001",
    frequency_hz: 1.20251e10,
    source_revision: "item-source-revision-99",
    field_ref: fieldRef,
  } as unknown as AnalysisResultSpectralItemSummary;
}

function selectionFromPublishedItem(
  manifest: AnalysisResultDatasetManifestResource,
  item: AnalysisResultSpectralItemSummary,
) {
  const ref = resultDatasetItemSelection(manifest, {
    branchId: item.branch_id ?? null,
    coordinateRefs: [],
    displayIndex: 0,
    fieldId: item.field_ref?.field_id ?? null,
    fieldRef: item.field_ref ?? null,
    itemId: item.item_id,
    itemKindCode: item.item_kind,
    sampleId: item.sample_id,
    sampleIndex: 0,
  } as never);
  return {
    kind: ref.kind,
    label: ref.itemId ?? ref.sampleId ?? ref.datasetId,
    nodeId: ref.nodeId,
    objectId: null,
    ref,
  };
}

function publishedPinFixture(
  productKind: PublishedProductKind = "modal_eigen",
  wavevectorCardinality: number | null = 2,
) {
  const manifest = publishedDataset(productKind, wavevectorCardinality);
  const item = publishedItem(productKind);
  const selection = selectionFromPublishedItem(manifest, item);
  const dataset = vi.fn().mockResolvedValue(manifest);
  const readItem = vi.fn().mockResolvedValue(item);
  const list = vi.fn().mockResolvedValue({ definitions: [], scene_revision: 11 });
  const create = vi.fn().mockResolvedValue({
    definition: { label: "Mode 1" },
    scene_revision: 12,
  });
  const invalidate = vi.fn();
  let current = true;
  const context = {
    api: {
      analysis: {
        results: { dataset, item: readItem },
        postprocessing: { definitions: { list, create } },
      },
    },
    selection: { get: () => selection },
    resources: { invalidate },
    sessionScopeKey: "session=owner&epoch=captured&request_scope_epoch=request",
    isCurrentSessionScope: () => current,
  };
  const command = pinCommand()!;
  return {
    context,
    command,
    create,
    dataset,
    expire: () => { current = false; },
    invalidate,
    item,
    list,
    manifest,
    readItem,
    selection,
  };
}

describe("pins from the typed Results item producer", () => {
  it.each([
    ["dispersion eigenmode", "modal_eigen", 2, "analysis.dispersion", "analysis.dispersion.mode_visualization.v1"],
    ["resonance eigenmode", "modal_eigen", null, "analysis.resonance", "analysis.resonance.mode_visualization.v1"],
    ["dispersion driven response", "driven_response", 2, "analysis.dispersion", "analysis.dispersion.mode_visualization.v1"],
    ["resonance driven response", "driven_response", null, "analysis.resonance", "analysis.resonance.mode_visualization.v1"],
  ] as const)(
    "uses the canonical manifest route for %s",
    async (_name, productKind, wavevectorCardinality, moduleId, schema) => {
      const fixture = publishedPinFixture(productKind, wavevectorCardinality);
      const result = await fixture.command.run(fixture.context as never);

      expect(result.status).toBe("completed");
      expect(fixture.dataset).toHaveBeenNthCalledWith(
        1,
        "run-1",
        "catalog:eigen-dispersion",
        { sessionScopeKey: fixture.context.sessionScopeKey },
      );
      expect(fixture.dataset).toHaveBeenCalledTimes(2);
      expect(fixture.readItem).toHaveBeenCalledExactlyOnceWith(
        "run-1",
        "catalog:eigen-dispersion",
        "mode-0000",
        { sessionScopeKey: fixture.context.sessionScopeKey },
      );
      const request = fixture.create.mock.calls[0]?.[0] as {
        definition: {
          module_id: string;
          definition_schema: string;
          data_ref: Record<string, unknown>;
        };
      };
      expect(request.definition).toMatchObject({
        module_id: moduleId,
        definition_schema: schema,
        data_ref: {
          run_id: "run-1",
          dataset_id: "catalog:eigen-dispersion",
          dataset_revision: "catalog-revision-7",
          field_id: fieldId,
          sample_id: "sample-0001",
          item_id: "mode-0000",
        },
      });
      expect(request.definition.data_ref).not.toHaveProperty("stage_id");
      expect(request.definition.data_ref).not.toHaveProperty("artifact_revision");
      expect(request.definition.data_ref.dataset_id).not.toBe(fixture.manifest.stage_id);
      expect(request.definition.data_ref.dataset_revision).not.toBe(fixture.item.source_revision);
      expect(fixture.create).toHaveBeenCalledWith(
        expect.objectContaining({ expected_scene_revision: 11 }),
        { sessionScopeKey: fixture.context.sessionScopeKey },
      );
    },
  );

  it("fails closed when the item or its selected field owner differs", async () => {
    const fixture = publishedPinFixture();
    const item = fixture.item;
    const mismatches = [
      { ...item, item_id: "foreign-item" },
      { ...item, sample_id: "foreign-sample" },
      { ...item, branch_id: "foreign-branch" },
      { ...item, item_kind: "driven_frequency_point" },
      { ...item, field_ref: { ...item.field_ref!, field_id: "foreign-field" } },
      { ...item, field_ref: { ...item.field_ref!, field_revision: "foreign-revision" } },
      { ...item, field_ref: { ...item.field_ref!, resource_key: "foreign-owner" } },
      { ...item, field_ref: { ...item.field_ref!, status: "pending" } },
      { ...item, field_ref: null },
    ];
    for (const mismatch of mismatches) {
      fixture.readItem.mockResolvedValueOnce(mismatch as AnalysisResultSpectralItemSummary);
      const result = await fixture.command.run(fixture.context as never);
      expect(result.status).toBe("failed");
    }
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("rejects a changed selected dataset revision before reading its item", async () => {
    const fixture = publishedPinFixture();
    fixture.dataset.mockResolvedValueOnce({
      ...fixture.manifest,
      dataset_revision: "foreign-revision",
    });
    const result = await fixture.command.run(fixture.context as never);

    expect(result.status).toBe("failed");
    expect(fixture.readItem).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("re-reads the exact dataset manifest after the item and rejects a revision change", async () => {
    const fixture = publishedPinFixture();
    fixture.dataset
      .mockResolvedValueOnce(fixture.manifest)
      .mockResolvedValueOnce({ ...fixture.manifest, dataset_revision: "new-revision" });
    const result = await fixture.command.run(fixture.context as never);

    expect(result.status).toBe("failed");
    expect(fixture.dataset).toHaveBeenCalledTimes(2);
    expect(fixture.readItem).toHaveBeenCalledTimes(1);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("rejects an unavailable mode-visualization template without mutating definitions", async () => {
    const fixture = publishedPinFixture();
    fixture.dataset.mockResolvedValue({
      ...fixture.manifest,
      capabilities: { fields: false },
    });
    const result = await fixture.command.run(fixture.context as never);

    expect(result.status).toBe("failed");
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("deduplicates a typed pin by its complete canonical owner", async () => {
    const fixture = publishedPinFixture();
    fixture.list.mockResolvedValue({
      definitions: [savedModeDefinition("catalog-revision-7")],
      scene_revision: 11,
    });

    const result = await fixture.command.run(fixture.context as never);

    expect(result.status).toBe("completed");
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged pin completed when resource invalidation throws", async () => {
    const fixture = publishedPinFixture();
    const history = seededAuthoringHistory();
    const generation = history.getGeneration();
    fixture.invalidate.mockImplementation(() => {
      throw new Error("resource invalidation failed");
    });

    const result = await fixture.command.run({
      ...fixture.context,
      authoringHistory: history,
    } as never);

    expect(result).toMatchObject({
      message: "Pinned Mode 1. Refresh the results view to see it.",
      status: "completed",
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.invalidate).toHaveBeenCalledTimes(1);
    expect(history.getGeneration()).toBe(generation + 1);
  });

  it("keeps a rejected typed pin failed without clearing history or invalidating", async () => {
    const fixture = publishedPinFixture();
    const history = seededAuthoringHistory();
    const generation = history.getGeneration();
    fixture.create.mockRejectedValueOnce(new Error("pin write rejected"));

    const result = await fixture.command.run({
      ...fixture.context,
      authoringHistory: history,
    } as never);

    expect(result).toMatchObject({
      message: "Mode visualization pin failed: pin write rejected",
      status: "failed",
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(history.getGeneration()).toBe(generation);
    expect(history.canUndo()).toBe(true);
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("does not read or write into a new session when the item read is pending", async () => {
    const fixture = publishedPinFixture();
    const pendingItem = deferred<AnalysisResultSpectralItemSummary>();
    const itemReadStarted = deferred<void>();
    fixture.readItem.mockImplementationOnce(() => {
      itemReadStarted.resolve(undefined);
      return pendingItem.promise;
    });
    const result = fixture.command.run(fixture.context as never);
    await itemReadStarted.promise;
    expect(fixture.readItem).toHaveBeenCalledTimes(1);
    fixture.expire();
    pendingItem.resolve(fixture.item);

    expect((await result).status).toBe("cancelled");
    expect(fixture.dataset).toHaveBeenCalledTimes(1);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});

describe("import dispersion reference command bounds", () => {
  it("preserves valid SI pairs through the existing definitions API command", async () => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points: [[3, 9], [-1, 2]],
      sourceUnits: { frequency: "GHz", path: "rad/um" },
    });
    fixture.create.mockResolvedValue({
      definition: { label: "Reference" },
      scene_revision: 12,
    });

    const result = await command.run(fixture.context);

    expect(result).toEqual({ message: "Imported reference Reference.", status: "completed" });
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        data_ref: { dataset_revision: "7", dataset_id: "stage-1", run_id: "run-1" },
        settings: expect.objectContaining({ points: [[3, 9], [-1, 2]] }),
      }),
      expected_scene_revision: 11,
    }), undefined);
    expectSceneRevisionInvalidations(fixture.invalidate.mock.calls, 12);
  });

  it.each([
    ["oversized points", Array.from({ length: MAX_REFERENCE_POINTS + 1 }, (_, index) => [index, index])],
    ["non-finite point", [[0, 1], [1, Number.NaN]]],
    ["malformed tuple", [[0, 1], [1, 2, 3]]],
  ])("rejects %s before listing or creating stored definitions", async (_label, points) => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points,
      sourceUnits: { frequency: "GHz", path: "rad/um" },
    });

    const result = await command.run(fixture.context);

    expect(result.status).toBe("failed");
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("rejects unsupported units without reading or mutating stored definitions", async () => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points: [[0, 1], [1, 2]],
      sourceUnits: { frequency: "kHz", path: "rad/m" },
    });

    const result = await command.run(fixture.context);

    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/supported units/);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("fails closed without WebCrypto SHA-256 and never creates a reference", async () => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points: [[0, 1], [1, 2]],
      sourceUnits: { frequency: "GHz", path: "rad/um" },
    });
    vi.stubGlobal("crypto", { subtle: undefined });

    try {
      const result = await command.run(fixture.context);

      expect(result).toMatchObject({
        message: "Reference import failed: SHA-256 digest is unavailable for reference identity.",
        status: "failed",
      });
      expect(fixture.list).toHaveBeenCalledTimes(1);
      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.invalidate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns facade failures as a command result", async () => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const list = vi.fn().mockRejectedValue(new Error("definitions unavailable"));
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points: [[0, 1], [1, 2]],
      sourceUnits: { frequency: "GHz", path: "rad/um" },
    }, list);

    const result = await command.run(fixture.context);

    expect(result).toMatchObject({ message: "Reference import failed: definitions unavailable", status: "failed" });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});

const scopedCommands = [
  IMPORT_DISPERSION_REFERENCE_COMMAND,
  PIN_MODE_VISUALIZATION_COMMAND,
  UNPIN_POSTPROCESSING_DEFINITION_COMMAND,
];

function scopedCommandFixture(commandId: string) {
  let current = true;
  const list = vi.fn().mockResolvedValue({ definitions: [], scene_revision: 11 });
  const results = legacyResultsApi();
  const mutation = vi.fn().mockResolvedValue(
    commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND
      ? { scene_revision: 13 }
      : { definition: { label: "Reference" }, scene_revision: 12 },
  );
  const invalidate = vi.fn();
  const context = {
    api: {
      analysis: {
        results,
        postprocessing: { definitions: { list, create: mutation, remove: mutation } },
      },
    },
    input: commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND
      ? { definitionId: "pin-1" }
      : { fileName: "reference.csv", label: "Reference", points: [[0, 1], [1, 2]],
          sourceUnits: { frequency: "GHz", path: "rad/um" } },
    selection: { get: modeSelection },
    resources: { invalidate },
    sessionScopeKey: "session=owner&epoch=captured&request_scope_epoch=request",
    isCurrentSessionScope: () => current,
  };
  const command = POSTPROCESSING_DEFINITION_COMMANDS.find((candidate) => candidate.id === commandId)!;
  return {
    context,
    list,
    mutation,
    invalidate,
    command,
    results,
    expire: () => { current = false; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function expectSceneRevisionInvalidations(
  calls: readonly (readonly unknown[])[],
  sceneRevision: number,
): void {
  expect(calls).toEqual([
    [MODEL_SCENE_PATH, sceneRevision],
    [ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH, sceneRevision],
  ]);
}

describe.each(scopedCommands)("postprocessing command session scope: %s", (commandId) => {
  it("forwards the captured scope to both the read and mutation", async () => {
    const fixture = scopedCommandFixture(commandId);
    const result = await fixture.command.run(fixture.context as never);
    const options = { sessionScopeKey: fixture.context.sessionScopeKey };
    expect(result.status).toBe("completed");
    expect(fixture.list).toHaveBeenCalledExactlyOnceWith(options);
    if (commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND) {
      expect(fixture.mutation).toHaveBeenCalledExactlyOnceWith("pin-1", { expected_scene_revision: 11 }, options);
    } else {
      expect(fixture.mutation).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ expected_scene_revision: 11 }), options,
      );
    }
    if (commandId === PIN_MODE_VISUALIZATION_COMMAND) {
      expect(fixture.results.datasets.mock.calls[0]?.[2]).toMatchObject({
        ...options,
        signal: expect.any(AbortSignal),
      });
      expect(fixture.results.items.mock.calls[0]?.[3]).toMatchObject({
        ...options,
        signal: expect.any(AbortSignal),
      });
      // Both the initial manifest and the pre-mutation revision fence
      // must retain the captured session scope.
      expect(fixture.results.dataset).toHaveBeenCalledTimes(2);
      for (const callNumber of [1, 2]) {
        expect(fixture.results.dataset).toHaveBeenNthCalledWith(
          callNumber,
          "run-1",
          "catalog:eigen-dispersion",
          options,
        );
      }
      expect(fixture.results.item).toHaveBeenCalledExactlyOnceWith(
        "run-1",
        "catalog:eigen-dispersion",
        "mode-0000",
        options,
      );
    }
    const acknowledgedSceneRevision =
      commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND ? 13 : 12;
    expectSceneRevisionInvalidations(
      fixture.invalidate.mock.calls,
      acknowledgedSceneRevision,
    );
  });

  it("does not read or mutate after its captured session has expired", async () => {
    const fixture = scopedCommandFixture(commandId);
    fixture.expire();
    expect((await fixture.command.run(fixture.context as never)).status).toBe("cancelled");
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("cancels legacy resolution when its catalog page completes in an expired session", async () => {
    if (commandId !== PIN_MODE_VISUALIZATION_COMMAND) return;
    const fixture = scopedCommandFixture(commandId);
    const catalogReadStarted = deferred<void>();
    const catalogRead = deferred<AnalysisResultDatasetCatalogResource>();
    fixture.results.datasets.mockImplementationOnce(() => {
      catalogReadStarted.resolve();
      return catalogRead.promise;
    });

    const pending = fixture.command.run(fixture.context as never);
    await catalogReadStarted.promise;
    fixture.expire();
    catalogRead.resolve(fixture.results.datasetCatalog);

    expect((await pending).status).toBe("cancelled");
    expect(fixture.results.items).not.toHaveBeenCalled();
    expect(fixture.results.dataset).not.toHaveBeenCalled();
    expect(fixture.results.item).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("does not submit a mutation when the session changes during the read", async () => {
    const fixture = scopedCommandFixture(commandId);
    const read = deferred<{ definitions: []; scene_revision: number }>();
    const readStarted = deferred<void>();
    fixture.list.mockImplementationOnce(() => {
      readStarted.resolve();
      return read.promise;
    });
    const result = fixture.command.run(fixture.context as never);
    await readStarted.promise;
    expect(fixture.list).toHaveBeenCalledTimes(1);
    fixture.expire();
    read.resolve({ definitions: [], scene_revision: 11 });
    expect((await result).status).toBe("cancelled");
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("does not invalidate the new session after an old-session mutation is acknowledged", async () => {
    const fixture = scopedCommandFixture(commandId);
    const acknowledged = deferred<{ definition: { label: string }; scene_revision: number }>();
    const submitted = deferred<void>();
    fixture.mutation.mockImplementationOnce(() => {
      submitted.resolve();
      return acknowledged.promise;
    });
    const result = fixture.command.run(fixture.context as never);
    await submitted.promise;
    fixture.expire();
    acknowledged.resolve({ definition: { label: "Reference" }, scene_revision: 12 });
    expect((await result).status).toBe("cancelled");
    expect(fixture.mutation).toHaveBeenCalledTimes(1);
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});

it("does not create an imported reference when the session expires during SHA-256", async () => {
  const fixture = scopedCommandFixture(IMPORT_DISPERSION_REFERENCE_COMMAND);
  const digestStarted = deferred<void>();
  const digestResult = deferred<ArrayBuffer>();
  const digest = vi.fn(() => {
    digestStarted.resolve();
    return digestResult.promise;
  });
  vi.stubGlobal("crypto", { subtle: { digest } });

  try {
    const pending = fixture.command.run(fixture.context as never);
    await digestStarted.promise;
    expect(fixture.list).toHaveBeenCalledExactlyOnceWith({ sessionScopeKey: fixture.context.sessionScopeKey });
    fixture.expire();
    digestResult.resolve(new ArrayBuffer(32));

    expect((await pending).status).toBe("cancelled");
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  } finally {
    digestResult.resolve(new ArrayBuffer(32));
    vi.unstubAllGlobals();
  }
});

function seededAuthoringHistory() {
  const before = { editor: { marker: "before" }, revision: 10 } satisfies SceneResource;
  const after = { editor: { marker: "after" }, revision: 11 } satisfies SceneResource;
  const history = new AuthoringHistoryController(
    { model: { scene: vi.fn().mockResolvedValue(after), commitTransaction: vi.fn() } },
    { invalidate: vi.fn() } as never,
  );
  history.record({ before, after, label: "Edit geometry", committedRevision: 11 });
  expect(history.canUndo()).toBe(true);
  return history;
}

describe.each(scopedCommands)("postprocessing mutation history invalidation: %s", (commandId) => {
  it("clears revision-stale undo entries after an acknowledged definition mutation", async () => {
    const fixture = scopedCommandFixture(commandId);
    const history = seededAuthoringHistory();
    const generation = history.getGeneration();
    const generationsAtInvalidation: number[] = [];
    fixture.invalidate.mockImplementation(() => {
      generationsAtInvalidation.push(history.getGeneration());
    });
    const result = await fixture.command.run({ ...fixture.context, authoringHistory: history } as never);
    expect(result.status).toBe("completed");
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.getGeneration()).toBe(generation + 1);
    const acknowledgedSceneRevision =
      commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND ? 13 : 12;
    expectSceneRevisionInvalidations(
      fixture.invalidate.mock.calls,
      acknowledgedSceneRevision,
    );
    expect(generationsAtInvalidation).toEqual([generation + 1, generation + 1]);
  });

  it("preserves history when the mutation fails before its acknowledgement", async () => {
    const fixture = scopedCommandFixture(commandId);
    const history = seededAuthoringHistory();
    const generation = history.getGeneration();
    fixture.mutation.mockRejectedValueOnce(new Error("mutation rejected"));
    try {
      const result = await fixture.command.run({ ...fixture.context, authoringHistory: history } as never);
      expect(result.status).toBe("failed");
    } catch (error) {
      expect(error).toEqual(new Error("mutation rejected"));
    }
    expect(history.canUndo()).toBe(true);
    expect(history.getGeneration()).toBe(generation);
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("does not clear history after an acknowledgement for an obsolete session", async () => {
    const fixture = scopedCommandFixture(commandId);
    const history = seededAuthoringHistory();
    const generation = history.getGeneration();
    const acknowledgement = deferred<{ definition: { label: string }; scene_revision: number }>();
    const submitted = deferred<void>();
    fixture.mutation.mockImplementationOnce(() => {
      submitted.resolve();
      return acknowledgement.promise;
    });
    const pending = fixture.command.run({ ...fixture.context, authoringHistory: history } as never);
    await submitted.promise;
    fixture.expire();
    acknowledgement.resolve({ definition: { label: "Reference" }, scene_revision: 12 });
    expect((await pending).status).toBe("cancelled");
    expect(history.canUndo()).toBe(true);
    expect(history.getGeneration()).toBe(generation);
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});

it("does not clear authoring history for an already pinned mode", async () => {
  const history = seededAuthoringHistory();
  const fixture = commandContext([savedModeDefinition("catalog-revision-7")], vi.fn(), history);
  const command = pinCommand();
  if (!command) throw new Error("Pin command is not registered");
  const result = await command.run(fixture.context);
  expect(result.status).toBe("completed");
  expect(fixture.create).not.toHaveBeenCalled();
  expect(history.canUndo()).toBe(true);
  expect(fixture.invalidate).not.toHaveBeenCalled();
});

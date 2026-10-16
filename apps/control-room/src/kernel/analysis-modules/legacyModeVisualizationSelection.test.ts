import { describe, expect, it, vi } from "vitest";

import type {
  AnalysisResultDatasetCatalogResource,
  AnalysisResultItemPageResource,
  AnalysisResultPageQuery,
} from "@/kernel/api/apiTypes";
import {
  legacyModeVisualizationIdentity,
  resolveLegacyModeVisualizationSelection,
} from "./legacyModeVisualizationSelection";

type ProductKind = "driven_response" | "modal_eigen";
type ItemKind = "driven_frequency_point" | "eigen_mode";

function dataset(
  datasetId: string,
  productKind: ProductKind = "modal_eigen",
  overrides: Record<string, unknown> = {},
) {
  return {
    dataset_id: datasetId,
    dataset_revision: "dataset-revision-7",
    item_count: 1,
    product_kind: productKind,
    run_id: "run-1",
    sample_count: 1,
    stage_id: "stage-1",
    status: "ready",
    title: datasetId,
    ...overrides,
  } as unknown as AnalysisResultDatasetCatalogResource["items"][number];
}

function catalogPage(
  items: AnalysisResultDatasetCatalogResource["items"],
  nextCursor: string | null = null,
  overrides: Partial<AnalysisResultDatasetCatalogResource> = {},
): AnalysisResultDatasetCatalogResource {
  return {
    items,
    next_cursor: nextCursor,
    revision: "catalog-revision-1",
    run_id: "run-1",
    schema_version: "analysis-result-dataset-catalog.v1",
    status: "ready",
    total_count: items.length,
    ...overrides,
  } as AnalysisResultDatasetCatalogResource;
}

function item(
  itemId: string,
  itemKind: ItemKind = "eigen_mode",
  overrides: Record<string, unknown> = {},
) {
  return {
    branch_id: "branch-1",
    field_ref: {
      field_id: "field-1",
      field_revision: "field-revision-1",
      resource_key: "analysis-result:field:owner-1",
      status: "ready",
    },
    item_id: itemId,
    item_kind: itemKind,
    sample_id: "sample-1",
    ...overrides,
  } as unknown as AnalysisResultItemPageResource["items"][number];
}

function itemPage(
  datasetId: string,
  items: AnalysisResultItemPageResource["items"],
  nextCursor: string | null = null,
  overrides: Record<string, unknown> = {},
): AnalysisResultItemPageResource {
  return {
    cursor: overrides.cursor ?? null,
    dataset_id: datasetId,
    dataset_revision: "dataset-revision-7",
    items,
    next_cursor: nextCursor,
    run_id: "run-1",
    total_count: items.length,
    ...overrides,
  } as unknown as AnalysisResultItemPageResource;
}

function legacySelection(
  kind = "results.dispersion.modal.mode_at_k",
  overrides: Record<string, unknown> = {},
) {
  return {
    kind,
    label: "Mode or response field",
    ref: {
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      branchId: "branch-1",
      fieldId: "field-1",
      kind,
      sampleId: "sample-1",
      type: "frequency-domain" as const,
      ...overrides,
    },
  };
}

function loaders({
  datasets = [dataset("dataset-1")],
  itemPages,
}: {
  datasets?: AnalysisResultDatasetCatalogResource["items"];
  itemPages?: readonly AnalysisResultItemPageResource[];
} = {}) {
  const loadDatasetPage = vi.fn(async (
    _query: AnalysisResultPageQuery,
    _signal: AbortSignal,
  ): Promise<AnalysisResultDatasetCatalogResource | null> => catalogPage(datasets));
  const pages = [...(itemPages ?? [itemPage("dataset-1", [item("item-1")])])];
  const loadItemPage = vi.fn(async (
    _datasetId: string,
    _query: AnalysisResultPageQuery,
    _signal: AbortSignal,
  ): Promise<AnalysisResultItemPageResource | null> => pages.shift() ?? null);
  return { loadDatasetPage, loadItemPage };
}

const signal = () => new AbortController().signal;

describe("legacy frequency-domain mode selection bridge", () => {
  it.each([
    ["chart modal field", "results.dispersion.modal.mode_at_k", "modal_eigen", "eigen_mode"],
    ["FMR inspector field", "results.eigen.mode", "modal_eigen", "eigen_mode"],
    ["driven response field", "results.resonance.driven.field", "driven_response", "driven_frequency_point"],
  ] as const)(
    "resolves %s through the exact catalog and item filters",
    async (_label, kind, productKind, itemKind) => {
      const product: ProductKind = productKind;
      const resultRows = [dataset("dataset-1", product)];
      const results = loaders({
        datasets: resultRows,
        itemPages: [itemPage(
          "dataset-1",
          [item("canonical-item", itemKind)],
        )],
      });
      const result = await resolveLegacyModeVisualizationSelection(
        legacySelection(kind, {
          artifactRevision: "artifact-revision-is-not-dataset-revision",
          modeId: "display-mode-is-not-item-id",
        }),
        signal(),
        results,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selection).toMatchObject({
        kind: "analysis.result",
        ref: {
          branchId: "branch-1",
          datasetId: "dataset-1",
          datasetRevision: "dataset-revision-7",
          fieldId: "field-1",
          fieldRevision: "field-revision-1",
          focus: "item",
          itemId: "canonical-item",
          itemKind,
          runId: "run-1",
          sampleId: "sample-1",
          stageId: "stage-1",
          type: "analysis-result",
        },
      });
      expect(results.loadDatasetPage).toHaveBeenCalledExactlyOnceWith(
        { product_kind: product, stage_id: "stage-1", limit: 500 },
        expect.any(AbortSignal),
      );
      expect(results.loadItemPage).toHaveBeenCalledExactlyOnceWith(
        "dataset-1",
        {
          has_field: true,
          item_kind: itemKind,
          limit: 50,
          sample_id: "sample-1",
          branch_id: "branch-1",
        },
        expect.any(AbortSignal),
      );
    },
  );

  it("accepts only known concrete field-bearing legacy kinds", () => {
    expect(legacyModeVisualizationIdentity(legacySelection("results.resonance.modal.modes"))).toMatchObject({
      ok: false,
    });
    expect(legacyModeVisualizationIdentity(legacySelection("results.eigen.mode", {
      sampleId: undefined,
    }))).toMatchObject({ ok: false });
    expect(legacyModeVisualizationIdentity(legacySelection("results.eigen.mode", {
      analysisRunId: undefined,
    }))).toMatchObject({ ok: false });
  });

  it("refuses multiple matching datasets and never reads their items", async () => {
    const results = loaders({
      datasets: [dataset("dataset-1"), dataset("dataset-2")],
    });
    const resolved = await resolveLegacyModeVisualizationSelection(
      legacySelection(),
      signal(),
      results,
    );
    expect(resolved).toMatchObject({ ok: false, reason: expect.stringContaining("multiple Results datasets") });
    expect(results.loadItemPage).not.toHaveBeenCalled();
  });

  it("refuses a missing catalog and a supplied dataset identity that does not match it", async () => {
    const missing = loaders();
    missing.loadDatasetPage.mockResolvedValueOnce(null);
    expect(await resolveLegacyModeVisualizationSelection(legacySelection(), signal(), missing))
      .toMatchObject({ ok: false });
    expect(missing.loadItemPage).not.toHaveBeenCalled();

    const mismatch = loaders();
    const resolved = await resolveLegacyModeVisualizationSelection(
      legacySelection("results.dispersion.modal.mode_at_k", {
        datasetId: "foreign-dataset",
        datasetRevision: "foreign-revision",
      }),
      signal(),
      mismatch,
    );
    expect(resolved).toMatchObject({ ok: false, reason: expect.stringContaining("not present") });
    expect(mismatch.loadItemPage).not.toHaveBeenCalled();
  });

  it("rejects a catalog page that violates the exact stage or product query", async () => {
    const results = loaders({
      datasets: [dataset("dataset-1", "modal_eigen", { stage_id: "foreign-stage" })],
    });
    const resolved = await resolveLegacyModeVisualizationSelection(
      legacySelection(),
      signal(),
      results,
    );
    expect(resolved).toMatchObject({ ok: false, reason: expect.stringContaining("did not honor") });
    expect(results.loadItemPage).not.toHaveBeenCalled();
  });

  it("fails closed for missing, duplicated, or non-ready field matches", async () => {
    const noField = loaders({
      itemPages: [itemPage("dataset-1", [item("item-no-match", "eigen_mode", {
        field_ref: { ...item("other").field_ref!, field_id: "other-field" },
      })])],
    });
    expect(await resolveLegacyModeVisualizationSelection(legacySelection(), signal(), noField))
      .toMatchObject({ ok: false, reason: expect.stringContaining("not present") });

    const duplicate = loaders({
      itemPages: [itemPage("dataset-1", [item("item-1"), item("item-2")])],
    });
    expect(await resolveLegacyModeVisualizationSelection(legacySelection(), signal(), duplicate))
      .toMatchObject({ ok: false, reason: expect.stringContaining("multiple Results items") });

    const notReady = loaders({
      itemPages: [itemPage("dataset-1", [item("item-pending", "eigen_mode", {
        field_ref: { ...item("other").field_ref!, status: "pending" },
      })])],
    });
    expect(await resolveLegacyModeVisualizationSelection(legacySelection(), signal(), notReady))
      .toMatchObject({ ok: false, reason: expect.stringContaining("ready field owner") });
  });

  it.each([
    ["sample", "sampleId", { sample_id: "foreign-sample" }],
    ["branch", "branchId", { branch_id: "foreign-branch" }],
  ] as const)(
    "rejects an item page that crosses the selected %s",
    async (_label, _field, itemOverrides) => {
      const results = loaders({
        itemPages: [itemPage("dataset-1", [item("foreign-owner", "eigen_mode", itemOverrides)])],
      });
      const resolved = await resolveLegacyModeVisualizationSelection(
        legacySelection(),
        signal(),
        results,
      );
      expect(resolved).toMatchObject({ ok: false });
    },
  );

  it("rejects a stale dataset revision on an item page", async () => {
    const results = loaders({
      itemPages: [itemPage("dataset-1", [item("item-1")], null, {
        dataset_revision: "stale-revision",
      })],
    });
    expect(await resolveLegacyModeVisualizationSelection(legacySelection(), signal(), results))
      .toMatchObject({ ok: false, reason: expect.stringContaining("revision changed") });
  });

  it("reads to the terminal item page before resolving a field", async () => {
    const first = itemPage("dataset-1", [item("item-other", "eigen_mode", {
      field_ref: { ...item("other").field_ref!, field_id: "another-field" },
    })], "cursor-after-1", { total_count: 2 });
    const last = itemPage("dataset-1", [item("item-target")], null, {
      cursor: "cursor-after-1",
      total_count: 2,
    });
    const results = loaders({ itemPages: [first, last] });

    const resolved = await resolveLegacyModeVisualizationSelection(
      legacySelection(),
      signal(),
      results,
    );

    expect(resolved).toMatchObject({
      ok: true,
      selection: { ref: { itemId: "item-target", fieldId: "field-1" } },
    });
    expect(results.loadItemPage).toHaveBeenCalledTimes(2);
    expect(results.loadItemPage.mock.calls[1]?.[1]).toMatchObject({
      cursor: "cursor-after-1",
    });
  });

  it("reads every item page and rejects repeated cursors", async () => {
    const first = itemPage("dataset-1", [item("item-1", "eigen_mode", {
      field_ref: { ...item("other").field_ref!, field_id: "another-field" },
    })], "cursor-next", { total_count: 2 });
    const second = itemPage("dataset-1", [item("item-2")], "cursor-next", {
      cursor: "cursor-next",
      total_count: 2,
    });
    const results = loaders({ itemPages: [first, second] });
    const resolved = await resolveLegacyModeVisualizationSelection(
      legacySelection(),
      signal(),
      results,
    );
    expect(resolved).toMatchObject({ ok: false, reason: expect.stringContaining("cursor repeated") });
    expect(results.loadItemPage).toHaveBeenCalledTimes(2);
    expect(results.loadItemPage.mock.calls[1]?.[1]).toMatchObject({ cursor: "cursor-next" });
  });

  it("rejects a mismatched echoed cursor instead of accepting the page", async () => {
    const results = loaders({
      itemPages: [itemPage("dataset-1", [item("item-1")], null, { cursor: "unexpected" })],
    });
    expect(await resolveLegacyModeVisualizationSelection(legacySelection(), signal(), results))
      .toMatchObject({ ok: false, reason: expect.stringContaining("response cursor") });
  });
});

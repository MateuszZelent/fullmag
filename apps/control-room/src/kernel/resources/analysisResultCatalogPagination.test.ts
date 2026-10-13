import { describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "../api/ControlRoomApi";

import type {
  AnalysisResultDatasetCatalogResource,
  AnalysisResultPageQuery,
} from "../api/apiTypes";
import {
  ANALYSIS_RESULT_DATASET_CATALOG_PAGE_SIZE,
  fetchCompleteAnalysisResultDatasetCatalog,
  type CompleteAnalysisResultDatasetCatalogOptions,
} from "./analysisResultCatalogPagination";

function item(datasetId: string, datasetRevision: string, runId = "run-1") {
  return {
    dataset_id: datasetId,
    dataset_revision: datasetRevision,
    run_id: runId,
  } as AnalysisResultDatasetCatalogResource["items"][number];
}

function page(
  items: AnalysisResultDatasetCatalogResource["items"],
  nextCursor: string | null = null,
  overrides: Partial<AnalysisResultDatasetCatalogResource> = {},
): AnalysisResultDatasetCatalogResource {
  return {
    items,
    next_cursor: nextCursor,
    revision: "catalog-r1",
    run_id: "run-1",
    schema_version: "analysis-result-dataset-catalog.v1",
    status: "ready",
    total_count: items.length,
    ...overrides,
  } as AnalysisResultDatasetCatalogResource;
}

function options(
  loadPage: CompleteAnalysisResultDatasetCatalogOptions["loadPage"],
  signal = new AbortController().signal,
  query: Omit<AnalysisResultPageQuery, "cursor" | "limit"> = {},
): CompleteAnalysisResultDatasetCatalogOptions {
  return { expectedRunId: "run-1", loadPage, query, signal };
}

describe("complete analysis result dataset catalog pagination", () => {
  it("includes datasets beyond the server's maximum single page", async () => {
    const allItems = Array.from({ length: 501 }, (_, index) =>
      item(`dataset-${index}`, "rev-1"),
    );
    const pages = [
      page(allItems.slice(0, 500), "cursor-after-500", { total_count: 501 }),
      page(allItems.slice(500), null, { total_count: 501 }),
    ];
    const loadPage = vi.fn(async () => pages.shift() ?? null);

    const catalog = await fetchCompleteAnalysisResultDatasetCatalog(
      options(loadPage),
    );

    expect(catalog?.items).toEqual(allItems);
    expect(catalog?.next_cursor).toBeNull();
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("keeps filters, requests the server page maximum, and publishes all pages", async () => {
    const requests: AnalysisResultPageQuery[] = [];
    const pages = [
      page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 3 }),
      page([item("dataset-b", "rev-1")], "cursor-3", { total_count: 3 }),
      page([item("dataset-c", "rev-1")], null, { total_count: 3 }),
    ];
    const loadPage = vi.fn(async (query: AnalysisResultPageQuery) => {
      requests.push(query);
      return pages.shift() ?? null;
    });

    const catalog = await fetchCompleteAnalysisResultDatasetCatalog(
      options(loadPage, new AbortController().signal, {
        product_kind: "modal_eigen",
        search: "branch",
      }),
    );

    expect(catalog?.items.map((entry) => entry.dataset_id)).toEqual([
      "dataset-a",
      "dataset-b",
      "dataset-c",
    ]);
    expect(catalog?.next_cursor).toBeNull();
    expect(requests).toEqual([
      {
        product_kind: "modal_eigen",
        search: "branch",
        limit: ANALYSIS_RESULT_DATASET_CATALOG_PAGE_SIZE,
      },
      {
        product_kind: "modal_eigen",
        search: "branch",
        limit: ANALYSIS_RESULT_DATASET_CATALOG_PAGE_SIZE,
        cursor: "cursor-2",
      },
      {
        product_kind: "modal_eigen",
        search: "branch",
        limit: ANALYSIS_RESULT_DATASET_CATALOG_PAGE_SIZE,
        cursor: "cursor-3",
      },
    ]);
  });

  it("rejects caller-supplied cursor and limit filters before fetching", async () => {
    const loadPage = vi.fn(async () => page([], null));
    const invalidQuery = { cursor: "caller-cursor", limit: 1 } as unknown as Omit<
      AnalysisResultPageQuery,
      "cursor" | "limit"
    >;

    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(
        options(loadPage, new AbortController().signal, invalidQuery),
      ),
    ).rejects.toThrow("filters cannot supply cursor or limit");
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("returns a missing first-page catalog without requesting more pages", async () => {
    const loadPage = vi.fn(async () => null);

    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(options(loadPage)),
    ).resolves.toBeNull();
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate dataset membership across pages", async () => {
    const pages = [
      page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 2 }),
      page([item("dataset-a", "rev-1")], null, { total_count: 2 }),
    ];
    const loadPage = vi.fn(async () => pages.shift() ?? null);

    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(options(loadPage)),
    ).rejects.toThrow("duplicate dataset membership");
  });

  it("rejects a dataset id repeated with a conflicting revision", async () => {
    const pages = [
      page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 2 }),
      page([item("dataset-a", "rev-2")], null, { total_count: 2 }),
    ];

    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(
        options(vi.fn(async () => pages.shift() ?? null)),
      ),
    ).rejects.toThrow("conflicting dataset_revision");
  });

  it("propagates a later-page API 404 instead of returning a partial catalog", async () => {
    const missing = new ControlRoomApiError("catalog page disappeared", 404);
    let calls = 0;
    const loadPage: CompleteAnalysisResultDatasetCatalogOptions["loadPage"] =
      async () => {
        calls += 1;
        if (calls === 1) {
          return page([item("dataset-a", "rev-1")], "cursor-2", {
            total_count: 2,
          });
        }
        throw missing;
      };

    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(options(loadPage)),
    ).rejects.toBe(missing);
    expect(calls).toBe(2);
  });

  it("rejects schema, status, and unsupported-reason drift between pages", async () => {
    const overrides = [
      { schema_version: "analysis-result-dataset-catalog.v2" },
      { status: "partial" },
      { unsupported_reason: "changed" },
    ];

    for (const override of overrides) {
      const pages = [
        page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 2 }),
        page([item("dataset-b", "rev-1")], null, {
          total_count: 2,
          ...override,
        }),
      ];
      await expect(
        fetchCompleteAnalysisResultDatasetCatalog(
          options(vi.fn(async () => pages.shift() ?? null)),
        ),
      ).rejects.toThrow("changed between pages");
    }
  });

  it("rejects changed catalog revision and total count between pages", async () => {
    const changedRevision = [
      page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 2 }),
      page([item("dataset-b", "rev-1")], null, {
        revision: "catalog-r2",
        total_count: 2,
      }),
    ];
    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(
        options(vi.fn(async () => changedRevision.shift() ?? null)),
      ),
    ).rejects.toThrow("changed between pages");

    const changedCount = [
      page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 2 }),
      page([item("dataset-b", "rev-1")], null, { total_count: 3 }),
    ];
    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(
        options(vi.fn(async () => changedCount.shift() ?? null)),
      ),
    ).rejects.toThrow("changed between pages");
  });

  it("rejects a page whose run changes during cursor pagination", async () => {
    const pages = [
      page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 2 }),
      page([item("dataset-b", "rev-1")], null, {
        run_id: "other-run",
        total_count: 2,
      }),
    ];

    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(
        options(vi.fn(async () => pages.shift() ?? null)),
      ),
    ).rejects.toThrow("page run_id changed");
  });

  it("rejects an item whose run differs from its catalog page", async () => {
    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(
        options(
          vi.fn(async () =>
            page([item("dataset-a", "rev-1", "other-run")]),
          ),
        ),
      ),
    ).rejects.toThrow("item must have the requested run");
  });

  it("rejects a terminal page that omits declared catalog members", async () => {
    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(
        options(
          vi.fn(async () =>
            page([item("dataset-a", "rev-1")], null, { total_count: 2 }),
          ),
        ),
      ),
    ).rejects.toThrow("did not complete total_count");
  });

  it("rejects a missing later page instead of returning the accumulated prefix", async () => {
    const pages: Array<AnalysisResultDatasetCatalogResource | null> = [
      page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 2 }),
      null,
    ];
    const loadPage = vi.fn(async () => pages.shift() ?? null);

    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(options(loadPage)),
    ).rejects.toThrow("catalog disappeared before all cursor pages were read");
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("rejects empty non-terminal pages instead of looping without progress", async () => {
    const loadPage = vi.fn(async () =>
      page([], "cursor-without-progress", { total_count: 1 }),
    );

    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(options(loadPage)),
    ).rejects.toThrow("non-terminal page must contain at least one item");
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("rejects repeated cursors and preserves abort before requesting a later page", async () => {
    const repeatedCursorPages = [
      page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 3 }),
      page([item("dataset-b", "rev-1")], "cursor-2", { total_count: 3 }),
    ];
    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(
        options(vi.fn(async () => repeatedCursorPages.shift() ?? null)),
      ),
    ).rejects.toThrow("cursor repeated");

    const controller = new AbortController();
    const reason = new Error("catalog request cancelled");
    const loadPage = vi.fn(async () => {
      controller.abort(reason);
      return page([item("dataset-a", "rev-1")], "cursor-2", { total_count: 2 });
    });
    await expect(
      fetchCompleteAnalysisResultDatasetCatalog(options(loadPage, controller.signal)),
    ).rejects.toBe(reason);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });
});

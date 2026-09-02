import { describe, expect, it } from "vitest";

import type {
  AnalysisResultDatasetCatalogResource,
  AnalysisResultDatasetManifestResource,
  AnalysisResultItemPageResource,
  AnalysisResultSamplePageResource,
} from "@/kernel/api/apiTypes";
import {
  buildResultDatasetBrowserModel,
  buildResultDatasetItemPageQuery,
} from "./resultDatasetBrowserModel";

const SAMPLE_COUNT = 10_000;
const ITEMS_PER_SAMPLE = 100;
const PAGE_SIZE = 50;
const DATASET_ID = "benchmark:results-mode-sweep";
const DATASET_REVISION = "sha256:results-mode-sweep-fixture";
const RUN_ID = "run:results-mode-sweep-fixture";

const status = {
  completeness: "ready",
  execution: "published",
  qualification: "validated",
  resource: "ready",
} as const;

const catalog = {
  items: [{
    dataset_id: DATASET_ID,
    dataset_revision: DATASET_REVISION,
    item_count: SAMPLE_COUNT * ITEMS_PER_SAMPLE,
    manifest_resource_key: "/benchmark/manifest",
    product_kind: "modal_eigen",
    run_id: RUN_ID,
    sample_count: SAMPLE_COUNT,
    stage_id: "stage:analysis",
    status,
    title: "10k sample x 100 item benchmark",
  }],
  revision: "sha256:results-mode-sweep-catalog",
  run_id: RUN_ID,
  schema_version: "analysis-result-index.v1",
  status: "ready",
  total_count: 1,
} as AnalysisResultDatasetCatalogResource;

const manifest = {
  axes: [{
    axis_id: "sample",
    cardinality: SAMPLE_COUNT,
    label: "Sample",
    role: "outer",
    unit_si: null,
    value_kind: "categorical",
  }],
  capabilities: {
    branch_tracking: false,
    comparison: false,
    export: false,
    fields: false,
    item_paging: true,
    live_partial_results: false,
    result_meshes: false,
    sample_paging: true,
    server_filtering: true,
    server_sorting: true,
  },
  dataset_id: DATASET_ID,
  dataset_revision: DATASET_REVISION,
  default_cursor: { item_id: null, sample_id: null },
  description: "Deterministic lazy benchmark fixture",
  item_index_resource: "/benchmark/items",
  item_kinds: ["eigen_mode"],
  product_kind: "modal_eigen",
  projections: [],
  provenance: {},
  run_id: RUN_ID,
  sample_index_resource: "/benchmark/samples",
  schema_version: "analysis-result-index.v1",
  source_artifacts: [],
  stage_id: "stage:analysis",
  status,
  title: "10k sample x 100 item benchmark",
  topology_policy: "shared",
  units_policy: "SI",
} as AnalysisResultDatasetManifestResource;

function samplePage(page: number): AnalysisResultSamplePageResource {
  const firstIndex = page * PAGE_SIZE;
  return {
    cursor: page === 0 ? null : `sample-cursor:${page}`,
    dataset_id: DATASET_ID,
    dataset_revision: DATASET_REVISION,
    items: Array.from({ length: Math.min(PAGE_SIZE, SAMPLE_COUNT - firstIndex) }, (_, offset) => {
      const sampleIndex = firstIndex + offset;
      return {
        coordinates: [{
          axis_id: "sample",
          category: null,
          entity_ref: null,
          label: `sample-${String(sampleIndex).padStart(5, "0")}`,
          scalar_si: null,
          token: `sample:${sampleIndex}`,
          vector3_si: null,
        }],
        equilibrium_ref: null,
        item_count: ITEMS_PER_SAMPLE,
        items_resource: `/benchmark/items?sample_id=sample:${sampleIndex}`,
        linearization_ref: null,
        mesh_ref: null,
        sample_id: `sample:${sampleIndex}`,
        sample_index: sampleIndex,
        source_revision: DATASET_REVISION,
        status,
      };
    }),
    limit: PAGE_SIZE,
    next_cursor: firstIndex + PAGE_SIZE < SAMPLE_COUNT ? `sample-cursor:${page + 1}` : null,
    run_id: RUN_ID,
    schema_version: "analysis-result-index.v1",
    total_count: SAMPLE_COUNT,
  };
}

function itemPage(sampleIndex: number): AnalysisResultItemPageResource {
  return {
    cursor: null,
    dataset_id: DATASET_ID,
    dataset_revision: DATASET_REVISION,
    items: Array.from({ length: PAGE_SIZE }, (_, index) => ({
      detail_resource: `/benchmark/items/mode:${sampleIndex}:${index}`,
      display_index: index,
      frequency_hz: (index + 1) * 1e9,
      item_id: `mode:${sampleIndex}:${index}`,
      item_kind: "eigen_mode",
      quality: { qualification: "validated", residual_relative_l2: 1e-12 },
      relations: [],
      sample_id: `sample:${sampleIndex}`,
      source_revision: DATASET_REVISION,
      status,
    })),
    limit: PAGE_SIZE,
    next_cursor: `item-cursor:${sampleIndex}:1`,
    run_id: RUN_ID,
    schema_version: "analysis-result-index.v1",
    total_count: ITEMS_PER_SAMPLE,
  };
}

describe("results mode sweep bounded benchmark", () => {
  it("builds only the current and one adjacent page for a 10k x 100 fixture", () => {
    const requestedPages = [0, 100, 198];
    const started = performance.now();
    const visiblePages = requestedPages.flatMap((currentPage) => [currentPage, currentPage + 1]
      .filter((page, index, pages) => page < SAMPLE_COUNT / PAGE_SIZE && pages.indexOf(page) === index)
      .map((page) => ({
        samples: samplePage(page),
        items: itemPage(page * PAGE_SIZE),
      })));
    const models = visiblePages.map(({ items, samples }) => buildResultDatasetBrowserModel({
      branches: null,
      catalog,
      items,
      manifest,
      samples,
      selectedDatasetId: DATASET_ID,
    }));
    const queries = visiblePages.map(({ samples }) => buildResultDatasetItemPageQuery({
      axisFilters: {},
      branchId: null,
      cursor: samples.cursor,
      frequencyMax: "",
      frequencyMin: "",
      itemFieldFilter: "all",
      itemStatusFilter: "all",
      itemSort: "display_index_asc",
      residualMax: "",
      sampleId: samples.items[0]?.sample_id ?? null,
      serverFiltering: true,
      serverSorting: true,
    }));
    const elapsedMs = performance.now() - started;

    expect(visiblePages).toHaveLength(requestedPages.length * 2);
    expect(visiblePages.every(({ samples, items }) =>
      samples.items.length <= PAGE_SIZE && items.items.length <= PAGE_SIZE,
    )).toBe(true);
    expect(models.every((model) =>
      model.samples.length <= PAGE_SIZE && model.items.length <= PAGE_SIZE,
    )).toBe(true);
    expect(models.at(-1)?.samples[0]?.sampleId).toBe("sample:9950");
    expect(queries.every((query) => query.limit === PAGE_SIZE)).toBe(true);
    expect(queries.every((query) =>
      Object.values(query).every((value) => !Array.isArray(value)),
    )).toBe(true);
    expect(queries.every((query) => !Object.hasOwn(query, "samples") && !Object.hasOwn(query, "modes"))).toBe(true);
    expect(JSON.stringify({ catalog, manifest }).length).toBeLessThan(10_000);
    console.info(`results-mode-sweep benchmark: ${elapsedMs.toFixed(2)} ms; ${visiblePages.length} pages; ${PAGE_SIZE} rows/page`);
  });
});

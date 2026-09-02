import { describe, expect, it } from "vitest";

import {
  buildResultDatasetBrowserModel,
  formatResultFrequency,
  resultDatasetCoordinateKey,
} from "./resultDatasetBrowserModel";

const status = {
  completeness: "ready",
  execution: "published",
  qualification: "validated",
  resource: "ready",
};

describe("result dataset browser model", () => {
  it("keeps dataset, sample and item identities stable across presentation labels", () => {
    const model = buildResultDatasetBrowserModel({
      catalog: {
        items: [
          {
            dataset_id: "dataset:modal",
            dataset_revision: "sha256:dataset",
            item_count: 2,
            manifest_resource_key: "/manifest",
            product_kind: "modal_eigen",
            run_id: "run:1",
            sample_count: 1,
            stage_id: "stage:analysis",
            status,
            title: "Field sweep",
          },
        ],
        revision: "sha256:catalog",
        run_id: "run:1",
        schema_version: "analysis-result-index.v1",
        status: "ready",
        total_count: 1,
      },
      branches: {
        cursor: null,
        dataset_id: "dataset:modal",
        dataset_revision: "sha256:dataset",
        items: [
          {
            branch_id: "branch:stable-1",
            label: "Branch 1",
            point_count: 1,
            points_resource: "/branches/branch:stable-1/points",
            source_revision: "sha256:branch",
            status,
          },
        ],
        limit: 50,
        next_cursor: null,
        run_id: "run:1",
        schema_version: "analysis-result-index.v1",
        total_count: 1,
        unsupported_reason: null,
      },
      items: {
        cursor: null,
        dataset_id: "dataset:modal",
        dataset_revision: "sha256:dataset",
        items: [
          {
            detail_resource: "/item",
            item_id: "mode:stable-1",
            item_kind: "eigen_mode",
            quality: { qualification: "validated" },
            relations: [],
            sample_id: "sample:stable-1",
            source_revision: "sha256:sample",
            status,
          },
        ],
        limit: 50,
        next_cursor: null,
        run_id: "run:1",
        schema_version: "analysis-result-index.v1",
        total_count: 1,
      },
      manifest: {
        axes: [],
        capabilities: {
          branch_tracking: true,
          comparison: false,
          export: false,
          fields: true,
          item_paging: true,
          live_partial_results: false,
          result_meshes: false,
          sample_paging: true,
          server_filtering: true,
          server_sorting: true,
        },
        dataset_id: "dataset:modal",
        dataset_revision: "sha256:dataset",
        default_cursor: { item_id: "mode:stable-1", sample_id: "sample:stable-1" },
        description: null,
        item_index_resource: "/items",
        item_kinds: ["eigen_mode"],
        product_kind: "modal_eigen",
        projections: [],
        provenance: {},
        run_id: "run:1",
        sample_index_resource: "/samples",
        schema_version: "analysis-result-index.v1",
        source_artifacts: [],
        stage_id: "stage:analysis",
        status,
        title: "Field sweep",
        topology_policy: "shared",
        units_policy: "SI",
      },
      samples: {
        cursor: null,
        dataset_id: "dataset:modal",
        dataset_revision: "sha256:dataset",
        items: [],
        limit: 50,
        next_cursor: null,
        run_id: "run:1",
        schema_version: "analysis-result-index.v1",
        total_count: 0,
      },
      selectedDatasetId: "dataset:modal",
    });

    expect(model.selectedDatasetId).toBe("dataset:modal");
    expect(model.items[0]?.itemId).toBe("mode:stable-1");
    expect(model.items[0]?.fieldAvailable).toBe(false);
    expect(model.branches[0]?.branchId).toBe("branch:stable-1");
  });

  it("uses tokens for coordinate keys and bounded frequency labels", () => {
    expect(resultDatasetCoordinateKey("bias-field", "bias-hx-0007")).toBe(
      "bias-field:bias-hx-0007",
    );
    expect(formatResultFrequency(2.5e9)).toBe("2.5000 GHz");
    expect(formatResultFrequency(null)).toBe("—");
  });
});

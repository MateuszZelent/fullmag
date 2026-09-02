import { describe, expect, it } from "vitest";

import {
  buildResultDatasetBrowserModel,
  buildResultDatasetItemPageQuery,
  formatResultFrequency,
  formatResultResidual,
  resultDatasetFilterErrorMessage,
  resultPageForDataset,
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
        items: [
          {
            coordinates: [
              {
                axis_id: "bias-field",
                category: null,
                entity_ref: null,
                label: "mu0 Hx = 75 mT",
                scalar_si: null,
                token: "bias:75mT",
                vector3_si: [0, 0, 0],
              },
            ],
            equilibrium_ref: null,
            item_count: 1,
            items_resource: "/items?sample_id=sample:stable-1",
            linearization_ref: null,
            mesh_ref: null,
            sample_id: "sample:stable-1",
            sample_index: 0,
            source_revision: "sha256:sample",
            status,
          },
        ],
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
    expect(model.items[0]?.selectable).toBe(true);
    expect(model.branches[0]?.branchId).toBe("branch:stable-1");
    expect(model.samples[0]?.label).toBe("mu0 Hx = 75 mT");
    expect(model.items[0]?.label).toBe("mode:stable-1");
  });

  it("does not make an invalid DSF probe selectable", () => {
    const model = buildResultDatasetBrowserModel({
      catalog: null,
      branches: null,
      items: {
        cursor: null,
        dataset_id: "dataset:dsf",
        dataset_revision: "revision:dsf",
        items: [{
          detail_resource: "/items/invalid",
          display_index: 3,
          frequency_hz: 2.0e9,
          item_id: "legacy:dsf:1:3",
          item_kind: "dsf_point",
          quality: { qualification: "legacy" },
          relations: [],
          sample_id: "dsf-sample-0000",
          source_revision: "revision:dsf",
          status: {
            completeness: "unsupported",
            execution: "published",
            qualification: "legacy",
            reason_code: "invalid_spatial_probe",
            resource: "unsupported",
          },
          wavevector_kf: [4.0, 0, 0],
        }],
        limit: 50,
        next_cursor: null,
        run_id: "run:1",
        schema_version: "analysis-result-index.v1",
        total_count: 1,
      },
      manifest: null,
      samples: null,
      selectedDatasetId: null,
    });
    expect(model.items[0]?.selectable).toBe(false);
    expect(model.items[0]?.label).toContain("DSF @ k=");
  });

  it("uses tokens for coordinate keys and bounded frequency labels", () => {
    expect(resultDatasetCoordinateKey("bias-field", "bias-hx-0007")).toBe(
      "bias-field:bias-hx-0007",
    );
    expect(formatResultFrequency(2.5e9)).toBe("2.5000 GHz");
    expect(formatResultFrequency(null)).toBe("—");
    expect(formatResultResidual(2.1e-10)).toBe("2.10e-10");
    expect(formatResultResidual(null)).toBe("—");
  });

  it("rejects result pages from a different immutable dataset revision", () => {
    const manifest = {
      dataset_id: "dataset:modal",
      dataset_revision: "sha256:current",
      run_id: "run:1",
    } as const;
    const page = {
      dataset_id: "dataset:modal",
      dataset_revision: "sha256:current",
      run_id: "run:1",
      rows: ["current"],
    } as const;

    expect(resultPageForDataset(page, manifest)).toBe(page);
    expect(
      resultPageForDataset(
        { ...page, dataset_revision: "sha256:stale" },
        manifest,
      ),
    ).toBeNull();
    expect(
      resultPageForDataset({ ...page, run_id: "run:foreign" }, manifest),
    ).toBeNull();
    expect(
      resultPageForDataset({ ...page, dataset_id: "dataset:foreign" }, manifest),
    ).toBeNull();
  });

  it("validates numeric item filters before building a server query", () => {
    expect(resultDatasetFilterErrorMessage("1e9", "2e9", "0.1")).toBeNull();
    expect(resultDatasetFilterErrorMessage("2e9", "1e9", "")).toBe(
      "Frequency minimum must not exceed frequency maximum.",
    );
    expect(resultDatasetFilterErrorMessage("", "", "-0.1")).toBe(
      "Residual maximum must not be negative.",
    );
    expect(resultDatasetFilterErrorMessage("not-a-number", "", "")).toBe(
      "Frequency minimum must be a finite number.",
    );
  });

  it("builds bounded item queries with independent sample scope and capabilities", () => {
    const query = buildResultDatasetItemPageQuery({
      axisFilters: { "bias-field": "bias:75mT" },
      branchId: "branch:1",
      cursor: "cursor:1",
      frequencyMax: "2e9",
      frequencyMin: "1e9",
      itemFieldFilter: "true",
      itemStatusFilter: "ready",
      itemSort: "frequency_asc",
      residualMax: "0.1",
      sampleId: "sample:1",
      serverFiltering: true,
      serverSorting: true,
    });
    expect(query).toMatchObject({
      "coordinate.bias-field": "bias:75mT",
      branch_id: "branch:1",
      cursor: "cursor:1",
      frequency_max_hz: 2e9,
      frequency_min_hz: 1e9,
      has_field: true,
      limit: 50,
      sample_id: "sample:1",
      sort: "frequency_asc",
      status: "ready",
    });

    const capabilityLimitedQuery = buildResultDatasetItemPageQuery({
      axisFilters: { "bias-field": "bias:75mT" },
      branchId: "branch:1",
      cursor: null,
      frequencyMax: "2e9",
      frequencyMin: "1e9",
      itemFieldFilter: "true",
      itemStatusFilter: "ready",
      itemSort: "frequency_asc",
      residualMax: "0.1",
      sampleId: "sample:1",
      serverFiltering: false,
      serverSorting: false,
    });
    expect(capabilityLimitedQuery).toEqual({ limit: 50, sample_id: "sample:1" });
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  AnalysisResultDatasetManifestResource,
  AnalysisResultFieldRef,
} from "@/kernel/api/apiTypes";
import type { AnalysisResultSelectionRef } from "@/shared/domain/analysis/results";
import { analysisResultSelectionRef } from "@/shared/domain/analysis/results";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 72,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 72,
      })),
    measureElement: () => undefined,
  }),
}));

import {
  ResultDatasetBrowser,
  resultDatasetItemSelection,
} from "./ResultDatasetBrowser";
import { buildResultDatasetBrowserModel } from "./resultDatasetBrowserModel";

vi.mock("@/kernel/resources/analysisResultResources", () => ({
  useAnalysisResultAxisValuesResource: () => ({
    data: {
      axis_id: "bias-field",
      cursor: null,
      dataset_id: "dataset:modal",
      dataset_revision: "sha256:dataset",
      limit: 256,
      next_cursor: null,
      run_id: "run:1",
      schema_version: "analysis-result-index.v1",
      total_count: 1,
      values: [
        {
          label: "mu0 Hx = 75 mT",
          scalar_si: 0.075,
          status: "ready",
          token: "bias:75mT",
        },
      ],
    },
    error: null,
    refetch: () => undefined,
    revision: "sha256:dataset",
    status: "ready",
  }),
}));

const status = {
  completeness: "ready",
  execution: "published",
  qualification: "validated",
  resource: "ready",
};

const manifest: AnalysisResultDatasetManifestResource = {
  axes: [],
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
  dataset_id: "dataset:modal",
  dataset_revision: "sha256:dataset",
  default_cursor: { item_id: null, sample_id: null },
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
  title: "Modal result",
  topology_policy: "shared",
  units_policy: "SI",
};

describe("ResultDatasetBrowser", () => {
  function renderBrowser(
    selectedSelection: AnalysisResultSelectionRef | null,
    browserManifest: AnalysisResultDatasetManifestResource = manifest,
    browserBranches: Parameters<typeof buildResultDatasetBrowserModel>[0]["branches"] = null,
    serverFiltering = true,
    serverSorting = true,
    axisDisplayUnits: Readonly<Record<string, string>> = {},
    onAxisDisplayUnitChange = () => undefined,
  ): string {
    const model = buildResultDatasetBrowserModel({
      branches: browserBranches,
      catalog: null,
      items: null,
      manifest: browserManifest,
      samples: null,
      selectedDatasetId: browserManifest.dataset_id,
    });

    return renderToStaticMarkup(
      <ResultDatasetBrowser
        axisFilters={{}}
        axisDisplayUnits={axisDisplayUnits}
        branchFilter={null}
        branchesPage={browserBranches}
        branchesResourceStatus="ready"
        catalogPage={null}
        catalogResourceStatus="ready"
        datasetSearch=""
        itemFieldFilter="all"
        itemFrequencyMax=""
        itemFrequencyMin=""
        itemFilterError={null}
        itemResidualMax=""
        itemStatusFilter="all"
        itemSort="display_index_asc"
        itemsPage={null}
        itemsResourceStatus="ready"
        manifest={browserManifest}
        manifestResourceStatus="ready"
        model={model}
        onAxisFilterChange={() => undefined}
        onAxisDisplayUnitChange={onAxisDisplayUnitChange}
        onBranchFilterChange={() => undefined}
        onBranchPageChange={() => undefined}
        onCatalogPageChange={() => undefined}
        onDatasetSearchChange={() => undefined}
        onInspectProvenance={() => undefined}
        onFollowBranch={() => undefined}
        onItemFieldFilterChange={() => undefined}
        onItemFrequencyMaxChange={() => undefined}
        onItemFrequencyMinChange={() => undefined}
        onItemPageChange={() => undefined}
        onItemResidualMaxChange={() => undefined}
        onItemStatusFilterChange={() => undefined}
        onItemSortChange={() => undefined}
        onOpenAnalysis={() => undefined}
        onPlotField={() => undefined}
        onSamplePageChange={() => undefined}
        onSelect={() => undefined}
        samplesPage={null}
        samplesResourceStatus="ready"
        serverFiltering={serverFiltering}
        serverSorting={serverSorting}
        selectedDatasetId={browserManifest.dataset_id}
        selectedSelection={selectedSelection}
        followedBranchId={null}
      />,
    );
  }

  it("exposes explicit actions for opening analysis and inspecting provenance", () => {
    const html = renderBrowser(null);

    expect(html).toContain("Open in Analysis");
    expect(html).toContain("Inspect provenance");
    expect(html).toContain("Item status");
    expect(html).toContain('aria-label="Frequency minimum [Hz]"');
    expect(html).toContain('aria-label="Residual maximum [relative L2]"');
    expect(html).not.toContain("Follow branch");
  });

  it("enables Plot field only for a selection from the displayed dataset revision", () => {
    const fieldRef: AnalysisResultFieldRef = {
      field_id: "analysis:eigen:sample-1:mode-1",
      field_revision: "sha256:field",
      mesh_ref: {
        mesh_id: "mesh:1",
        mesh_revision: "1",
        topology_fingerprint: "sha256:topology",
      },
      quantity_id: "m",
      representation: "complex-vector-xyz",
      resource_key: "data/fields/mode-1",
      status: "ready",
    };
    const selection = analysisResultSelectionRef({
      datasetId: manifest.dataset_id,
      datasetRevision: manifest.dataset_revision,
      fieldId: fieldRef.field_id,
      fieldRef,
      fieldRevision: fieldRef.field_revision,
      focus: "item",
      itemId: "mode-1",
      itemKind: "eigen_mode",
      runId: manifest.run_id,
      sampleId: "sample-1",
      stageId: manifest.stage_id,
    });
    const staleSelection = {
      ...selection,
      datasetRevision: "sha256:stale-dataset",
    };

    const enabledHtml = renderBrowser(selection);
    const staleHtml = renderBrowser(staleSelection);
    expect(enabledHtml).toMatch(/<button[^>]*>Plot field<\/button>/);
    expect(staleHtml).toMatch(/<button[^>]*\sdisabled(?:="")?[^>]*>Plot field<\/button>/);
  });

  it("keeps unsupported server capabilities explicit and disables the controls", () => {
    const html = renderBrowser(null, manifest, null, false, true);

    expect(html).toContain("Server filtering is unavailable for this dataset.");
    expect(html).toContain('aria-label="Frequency minimum [Hz]"');
  });

  it("keeps the item branch in the shared kernel selection", () => {
    const item = buildResultDatasetBrowserModel({
      branches: null,
      catalog: null,
      items: {
        cursor: null,
        dataset_id: manifest.dataset_id,
        dataset_revision: manifest.dataset_revision,
        items: [
          {
            branch_id: "branch:tracked",
            detail_resource: "/items/mode-1",
            field_ref: {
              field_id: "field:mode-1",
              field_revision: "sha256:field",
              mesh_ref: null,
              quantity_id: "m",
              representation: "complex-vector-xyz",
              resource_key: "/fields/mode-1",
              status: "ready",
            },
            item_id: "mode-1",
            item_kind: "eigen_mode",
            quality: { qualification: "validated", residual_relative_l2: 1e-10 },
            relations: [],
            sample_id: "sample-1",
            source_revision: "sha256:item",
            status,
          },
        ],
        limit: 50,
        next_cursor: null,
        run_id: manifest.run_id,
        schema_version: manifest.schema_version,
        total_count: 1,
      },
      manifest,
      samples: null,
      selectedDatasetId: manifest.dataset_id,
    });
    const selection = resultDatasetItemSelection(manifest, item.items[0]!);

    expect(selection.branchId).toBe("branch:tracked");
    expect(selection.itemId).toBe("mode-1");
    expect(selection.fieldId).toBe("field:mode-1");
    expect(selection.fieldRevision).toBe("sha256:field");
  });

  it("loads server-paged values for every filterable axis instead of leaving a dead control", () => {
    const pagedManifest: AnalysisResultDatasetManifestResource = {
      ...manifest,
      axes: [
        {
          axis_id: "bias-field",
          cardinality: 15,
          inline_values: null,
          label: "Bias field",
          ordering: "source_order",
          preferred_display_units: ["mT"],
          projections: [],
          role: "outer_sweep",
          semantic_id: "bias_field_a_per_m",
          symbol: "mu0 Hx",
          unit_si: "T",
          value_kind: "scalar",
          values_resource_key: "/axes/bias-field/values",
        },
      ],
    };

    const html = renderBrowser(null, pagedManifest);

    expect(html).toContain('aria-label="Bias field value"');
    expect(html).toContain('aria-label="Bias field search"');
    expect(html).toContain('data-slot="select-trigger"');
    expect(html).not.toContain("Values are paged by the server");
  });

  it("renders the selected display unit without changing the canonical axis selector", () => {
    const displayManifest: AnalysisResultDatasetManifestResource = {
      ...manifest,
      axes: [
        {
          axis_id: "bias-field",
          cardinality: 1,
          inline_values: [
            {
              category: null,
              entity_ref: null,
              label: "mu0 Hx = 75 mT",
              scalar_si: 0.075,
              status: "ready",
              token: "bias:75mT",
              vector3_si: null,
            },
          ],
          label: "Bias field",
          ordering: "source_order",
          preferred_display_units: ["mT", "T"],
          projections: [],
          role: "outer_sweep",
          semantic_id: "bias_field_t",
          symbol: "mu0 Hx",
          unit_si: "T",
          value_kind: "scalar",
          values_resource_key: null,
        },
      ],
    };
    const onDisplayUnitChange = vi.fn();
    const html = renderBrowser(
      null,
      displayManifest,
      null,
      true,
      true,
      { "bias-field": "mT" },
      onDisplayUnitChange,
    );

    expect(html).toContain('aria-label="Bias field display unit"');
    expect(html).toContain("Bias field: 1 mT");
  });

  it("exposes follow-branch action only through the tracked branch resource", () => {
    const branchManifest: AnalysisResultDatasetManifestResource = {
      ...manifest,
      capabilities: { ...manifest.capabilities, branch_tracking: true },
    };
    const branches = {
      cursor: null,
      dataset_id: manifest.dataset_id,
      dataset_revision: manifest.dataset_revision,
      items: [
        {
          branch_id: "branch:tracked",
          label: "Tracked branch",
          point_count: 3,
          points_resource: "/branches/branch:tracked/points",
          source_revision: "sha256:branch",
          status,
        },
      ],
      limit: 50,
      next_cursor: null,
      run_id: manifest.run_id,
      schema_version: manifest.schema_version,
      total_count: 1,
      unsupported_reason: null,
    };

    const html = renderBrowser(null, branchManifest, branches);

    expect(html).toContain("Follow branch");
    expect(html).toContain("Branch filter");
    expect(html).toContain("branch:tracked");
  });
});

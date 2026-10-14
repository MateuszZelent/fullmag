import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelProvider } from "@/kernel/KernelProvider";
import type {
  AnalysisResultFieldRef,
  AnalysisResultSpectralItemSummary,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { analysisResultSelectionRef } from "@/shared/domain/analysis/results";
import { AnalysisResultInspectorPanel } from "./AnalysisResultInspectorPanel";

const resourceMocks = vi.hoisted(() => ({
  itemData: null as unknown,
}));

vi.mock("@/kernel/resources/analysisResultResources", () => ({
  useAnalysisResultBranchResource: () => ({ data: null, status: "idle" }),
  useAnalysisResultDatasetManifestResource: () => ({ data: null, status: "idle" }),
  useAnalysisResultItemResource: () => ({ data: resourceMocks.itemData, status: "ready" }),
  useAnalysisResultProjectionResource: () => ({ data: null, status: "idle" }),
  useAnalysisResultSamplesResource: () => ({ data: null, status: "idle" }),
}));

const fieldRef: AnalysisResultFieldRef = {
  field_id: "analysis:eigen:sample-0001:mode-0002",
  field_revision: "sha256:field-v1",
  mesh_ref: {
    mesh_id: "mesh:shared-domain",
    mesh_revision: "41",
    topology_fingerprint: "sha256:topology-v1",
  },
  quantity_id: "m",
  representation: "complex-vector-xyz",
  resource_key: "data/fields/mode-0002",
  status: "ready",
};

function resultItem(trackingScore?: number | null): AnalysisResultSpectralItemSummary {
  return {
    branch_id: null,
    detail_resource: "/item/mode-0002",
    display_index: 1,
    field_ref: null,
    frequency_hz: 2.5e9,
    item_id: "mode-0002",
    item_kind: "eigen_mode",
    quality: {
      qualification: "unvalidated",
      residual_relative_l2: null,
      tracking_score: trackingScore,
    },
    relations: [],
    sample_id: "sample-0001",
    source_revision: "sha256:source-v1",
    status: {
      completeness: "ready",
      execution: "published",
      qualification: "unvalidated",
      resource: "ready",
    },
    wavevector_kf: null,
  };
}

function renderPanel() {
  return renderToStaticMarkup(
    <KernelProvider>
      <AnalysisResultInspectorPanel selection={analysisResultSelection()} />
    </KernelProvider>,
  );
}

function analysisResultSelection(): Selection {
  const ref = analysisResultSelectionRef({
    datasetId: "result:run-1:stage-1:modal-eigen-field-sweep",
    datasetRevision: "sha256:dataset-v1",
    fieldId: fieldRef.field_id,
    fieldRef,
    fieldRevision: fieldRef.field_revision,
    focus: "item",
    itemId: "mode-0002",
    itemKind: "eigen_mode",
    runId: "run-1",
    sampleId: "sample-0001",
    stageId: "stage-1",
  });
  return {
    kind: "analysis.result",
    label: "Eigen mode 2",
    moduleSource: "results-navigator",
    nodeId: ref.nodeId,
    objectId: null,
    ref,
  };
}

describe("AnalysisResultInspectorPanel", () => {
  beforeEach(() => {
    resourceMocks.itemData = null;
  });

  it("keeps phase, animation, and component controls on the canonical result field", () => {
    const html = renderToStaticMarkup(
      <KernelProvider>
        <AnalysisResultInspectorPanel selection={analysisResultSelection()} />
      </KernelProvider>,
    );

    expect(html).toContain("Phase and animation");
    expect(html).toContain('aria-label="Mode visualization phase"');
    expect(html).toContain('aria-label="Mode phase animation"');
    expect(html).toContain('aria-label="Result field field component"');
    expect(html).toContain('aria-label="Result field 3D view"');
  });

  it("preserves zero tracking scores and reports missing scores as unavailable", () => {
    resourceMocks.itemData = resultItem(0);
    const zeroHtml = renderPanel();

    expect(zeroHtml).toMatch(
      /class="fm-inspector-field-row__label">Tracking score<\/span><span[^>]*>0<\/span>/,
    );

    for (const missingScore of [null, undefined]) {
      resourceMocks.itemData = resultItem(missingScore);
      const missingHtml = renderPanel();

      expect(missingHtml).toMatch(
        /class="fm-inspector-field-row__label">Tracking score<\/span><span[^>]*>Unavailable<\/span>/,
      );
    }
  });
});

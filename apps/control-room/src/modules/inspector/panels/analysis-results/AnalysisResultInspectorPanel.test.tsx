import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KernelProvider } from "@/kernel/KernelProvider";
import type { AnalysisResultFieldRef } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { analysisResultSelectionRef } from "@/shared/domain/analysis/results";

import { AnalysisResultInspectorPanel } from "./AnalysisResultInspectorPanel";

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
});

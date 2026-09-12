import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResultsNavigatorTree } from "./ResultsNavigatorTree";
import type { ResultsNavigatorNode } from "./resultsNavigatorTypes";

const root: ResultsNavigatorNode = {
  children: [
    {
      children: Array.from({ length: 75 }, (_, index) => ({
        id: `results:mode:${index}`,
        inspectorId: "frequency-domain/eigen/mode",
        kind: "results.frequency-domain.mode",
        label: `Mode mode-${index}`,
        parentId: "results:modes",
        resourceKey: `analysis:eigen:mode:${index}`,
        status: "ready",
      })),
      collection: { pageCount: 2, pageSize: 50, totalCount: 75 },
      id: "results:modes",
      inspectorId: "frequency-domain/eigen/modes",
      kind: "results.frequency-domain.modes",
      label: "Modes",
      parentId: "results",
      resourceKey: "analysis:eigen:modes",
      status: "ready",
    },
  ],
  id: "results",
  inspectorId: "frequency-domain/overview",
  kind: "results.root",
  label: "Results",
  parentId: null,
  resourceKey: "results:navigator",
  status: "partial",
};

describe("ResultsNavigatorTree", () => {
  it("renders resource state and does not silently render a fixed 64-item slice", () => {
    const html = renderToStaticMarkup(
      <ResultsNavigatorTree nodes={[root]} selectedNodeId={null} />,
    );

    expect(html).toContain('aria-label="Results navigator"');
    expect(html).toContain('data-status="partial"');
    expect(html).not.toContain("Mode mode-64");
    expect(html).not.toContain("slice(0,64)");
  });

  it("renders a resource status reason for partial or corrupt nodes", () => {
    const reasonNode: ResultsNavigatorNode = {
      ...root,
      status: "error",
      statusReason: "Spectrum artifact is corrupt.",
    };
    const html = renderToStaticMarkup(
      <ResultsNavigatorTree nodes={[reasonNode]} selectedNodeId={null} />,
    );
    expect(html).toContain("Spectrum artifact is corrupt.");
    expect(html).toContain('data-status-reason="true"');
  });
});

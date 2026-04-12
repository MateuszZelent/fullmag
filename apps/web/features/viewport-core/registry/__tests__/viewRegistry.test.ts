import { describe, expect, it } from "vitest";

import { resolveActiveView, type WorkspaceViewContext } from "../viewRegistry";

function ctx(overrides: Partial<WorkspaceViewContext>): WorkspaceViewContext {
  return {
    viewportMode: "Analyze",
    hasSessionData: true,
    hasFemMesh: true,
    selectedResultNodeId: null,
    discretization: "fem",
    ...overrides,
  };
}

describe("viewRegistry", () => {
  it("routes plot groups to hosted chart view", () => {
    expect(resolveActiveView(ctx({ selectedResultNodeId: "res-plot-group-pg-1" })).componentKey).toBe(
      "ResultChartViewport",
    );
  });

  it("routes tables to hosted table view", () => {
    expect(resolveActiveView(ctx({ selectedResultNodeId: "res-table-tbl-1" })).componentKey).toBe(
      "ResultTableViewport",
    );
  });

  it("routes reports and exports to hosted summary view", () => {
    expect(resolveActiveView(ctx({ selectedResultNodeId: "res-report-rpt-1" })).componentKey).toBe(
      "ResultReportViewport",
    );
    expect(resolveActiveView(ctx({ selectedResultNodeId: "res-export-exp-1" })).componentKey).toBe(
      "ResultReportViewport",
    );
  });
});

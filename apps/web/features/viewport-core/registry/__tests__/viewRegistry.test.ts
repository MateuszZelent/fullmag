import { describe, expect, it } from "vitest";

import {
  VIEW_REGISTRY,
  resolveActiveView,
  type WorkspaceViewContext,
} from "../viewRegistry";

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
  it("does not expose legacy viewport component keys", () => {
    const keys = VIEW_REGISTRY.map((entry) => entry.componentKey);
    expect(keys).not.toContain("VectorFieldView3D");
    expect(keys).not.toContain("FemMeshView3D");
    expect(keys).not.toContain("FemMeshView3D_Mesh");
    expect(keys).not.toContain("MagnetizationSlice2D");
  });

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

  it("routes Mesh workspace through unified viewport host", () => {
    expect(resolveActiveView(ctx({ viewportMode: "Mesh" })).componentKey).toBe(
      "UnifiedViewport3D",
    );
  });

  it("routes every 3D/Mesh workspace variant to unified 3D component", () => {
    const cases: Array<Partial<WorkspaceViewContext>> = [
      { viewportMode: "3D", hasSessionData: true, discretization: "fem" },
      { viewportMode: "3D", hasSessionData: true, discretization: "fdm" },
      { viewportMode: "3D", hasSessionData: true, discretization: null },
      { viewportMode: "Mesh", hasSessionData: true, discretization: "fem" },
      { viewportMode: "Mesh", hasSessionData: true, discretization: "fdm" },
      { viewportMode: "Mesh", hasSessionData: false, discretization: "fem" },
      { viewportMode: "Mesh", hasSessionData: false, discretization: "fdm" },
      { viewportMode: "Mesh", hasSessionData: false, discretization: null },
    ];

    for (const variant of cases) {
      expect(resolveActiveView(ctx(variant)).componentKey).toBe("UnifiedViewport3D");
    }
  });

  it("routes 2D workspace through unified viewport host", () => {
    expect(resolveActiveView(ctx({ viewportMode: "2D" })).componentKey).toBe(
      "UnifiedViewport2D",
    );
  });
});

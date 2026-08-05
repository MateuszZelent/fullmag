import { describe, expect, it } from "vitest";

import { resolveObjectRegionOverviewLaneView } from "./ObjectRegionOverviewPanel";

describe("ObjectRegionOverviewPanel lane presentation", () => {
  it("keeps FDM region identity read-only and without FEM diagnostics", () => {
    expect(resolveObjectRegionOverviewLaneView("fdm")).toEqual({
      inlineDiagnostics: false,
      realization: "fdm",
    });
  });

  it("withholds FEM realization controls and diagnostics until the lane resolves", () => {
    expect(resolveObjectRegionOverviewLaneView("unknown")).toEqual({
      inlineDiagnostics: false,
      realization: "unknown",
    });
  });

  it("preserves FEM diagnostics and realization controls on the FEM lane", () => {
    expect(resolveObjectRegionOverviewLaneView("fem")).toEqual({
      inlineDiagnostics: true,
      realization: "fem",
    });
  });
});

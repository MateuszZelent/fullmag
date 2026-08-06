import { describe, expect, it } from "vitest";

import { resolveObjectRegionDiagnosticsLaneView } from "./ObjectRegionDiagnosticsPanel";

const model = {
  mode: "committed",
  realizationPolicy: "project",
  realizationStatus: "realized",
} as never;

describe("ObjectRegionDiagnosticsPanel lane presentation", () => {
  it("does not expose FEM realization status on the FDM lane", () => {
    expect(resolveObjectRegionDiagnosticsLaneView(model, "fdm")).toEqual({
      realizationPolicy: "Runtime-derived structured-grid membership",
      realizationStatus: "Runtime-derived structured-grid membership",
    });
  });

  it("withholds realization status until an unknown lane resolves", () => {
    expect(resolveObjectRegionDiagnosticsLaneView(model, "unknown")).toEqual({
      realizationPolicy: "Withheld until the session discretization is explicit",
      realizationStatus: "Withheld until the session discretization is explicit",
    });
  });

  it("preserves FEM realization provenance on the FEM lane", () => {
    expect(resolveObjectRegionDiagnosticsLaneView(model, "fem")).toEqual({
      realizationPolicy: "project",
      realizationStatus: "realized",
    });
  });
});

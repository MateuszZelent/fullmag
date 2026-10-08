import { describe, expect, it } from "vitest";

import { analysisModuleIdForNodeKind, analysisSurfaceForSelectionKind } from "./analysisSurfaceRouting";

describe("Analysis surface routing from the selected Results node", () => {
  it("follows the owning module of legacy and module node kinds", () => {
    expect(analysisSurfaceForSelectionKind("results.dispersion.modal.relation")).toBe("dispersion");
    expect(analysisSurfaceForSelectionKind("analysis.dispersion.mode_visualization")).toBe("dispersion");
    expect(analysisSurfaceForSelectionKind("results.resonance.driven.spectrum")).toBe("resonance-fmr");
    expect(analysisSurfaceForSelectionKind("results.observation_frame")).toBe("dynamics");
  });

  it("leaves Analysis unchanged for nodes that do not belong to an analysis", () => {
    expect(analysisSurfaceForSelectionKind("object.visualization")).toBeNull();
    expect(analysisSurfaceForSelectionKind("analysis-chart-point")).toBeNull();
    expect(analysisSurfaceForSelectionKind(null)).toBeNull();
  });

  it("derives the module id from the node kind", () => {
    expect(analysisModuleIdForNodeKind("results.dispersion.k_sampling")).toBe("analysis.dispersion");
    expect(analysisModuleIdForNodeKind("analysis.time-domain.spectrum")).toBe("analysis.time-domain");
    expect(analysisModuleIdForNodeKind("results.tables.root")).toBeNull();
  });
});

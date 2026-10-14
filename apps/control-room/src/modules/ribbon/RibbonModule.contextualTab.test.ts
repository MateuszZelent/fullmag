import { describe, expect, it } from "vitest";

import { EMPTY_SELECTION, type Selection } from "@/kernel/selection/selectionTypes";

import { __ribbonModuleTestUtils } from "./RibbonModule";

const {
  contextualAnalysisModuleIdForSelection,
  contextualRibbonTabIsActive,
  contextualTabDismissalForModuleChange,
} = __ribbonModuleTestUtils;

describe("Ribbon contextual module selection", () => {
  it("uses the typed module owner on pinned-visualization root selections", () => {
    const selection: Selection = {
      ...EMPTY_SELECTION,
      kind: "results.pinned_visualizations.root",
      label: "Pinned visualizations",
      nodeId: "results:pinned-visualizations",
      ref: {
        kind: "results.pinned_visualizations.root",
        moduleId: "analysis.dispersion",
        nodeId: "results:pinned-visualizations",
        runId: "run-1",
        type: "analysis-pinned-group",
      },
    };

    expect(contextualAnalysisModuleIdForSelection(selection)).toBe("analysis.dispersion");
    expect(contextualAnalysisModuleIdForSelection({
      ...selection,
      ref: {
        kind: "results.pinned_visualizations.root",
        moduleId: "unknown-module",
        nodeId: "results:pinned-visualizations",
        runId: "run-1",
        type: "analysis-pinned-group",
      },
    })).toBeNull();
    expect(contextualAnalysisModuleIdForSelection({
      ...EMPTY_SELECTION,
      kind: "results.dispersion.k_sampling",
    })).toBe("analysis.dispersion");
  });

  it("keeps ordinary tab dismissal within the same module and resets after leaving and returning", () => {
    const dispersion = "analysis.dispersion";
    const resonance = "analysis.resonance";
    let state = contextualTabDismissalForModuleChange(
      { contextModuleId: dispersion, dismissed: false },
      dispersion,
    );
    state = { ...state, dismissed: true };
    expect(contextualRibbonTabIsActive(state, dispersion, true)).toBe(false);

    state = contextualTabDismissalForModuleChange(state, resonance);
    expect(contextualRibbonTabIsActive(state, resonance, true)).toBe(true);
    state = contextualTabDismissalForModuleChange(state, dispersion);
    expect(contextualRibbonTabIsActive(state, dispersion, true)).toBe(true);

    state = { ...state, dismissed: true };
    state = contextualTabDismissalForModuleChange(state, dispersion);
    expect(contextualRibbonTabIsActive(state, dispersion, true)).toBe(false);
    expect(contextualRibbonTabIsActive(state, dispersion, false)).toBe(false);
  });
});

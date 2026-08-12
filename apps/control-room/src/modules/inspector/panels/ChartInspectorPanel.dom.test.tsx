import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom, TestElement, TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { analysisWorkspaceStore, resetAnalysisWorkspaceForTests } from "@/kernel/workspace/analysisWorkspace";

let descriptorPreferences: Record<string, { displayUnits: Record<string, string>; range: { fromSI: number; toSI: number } | null; selectedSeriesIds: string[] }> = {};
const setDescriptorPreference = vi.fn((id: string, descriptor: { displayUnits: Record<string, string>; range: { fromSI: number; toSI: number } | null; selectedSeriesIds: string[] }) => {
  descriptorPreferences = { ...descriptorPreferences, [id]: descriptor };
});

vi.mock("@/kernel/workspace/useAnalysisViewPreferencesHydration", () => ({
  useAnalysisViewPreferencesHydration: () => ({
    preferences: { descriptorPreferences },
    setDescriptorPreference,
  }),
}));

import { ChartInspectorPanel } from "./ChartInspectorPanel";

afterEach(() => {
  descriptorPreferences = {};
  resetAnalysisWorkspaceForTests();
  setDescriptorPreference.mockClear();
});

describe("ChartInspectorPanel active descriptor selection", () => {
  it.each([
    ["dynamics", "dynamics:v-table-a", "data.table:table-a:step:mx"],
    ["resonance-fmr", "artifact:frequency-response:v-response", "frequency:artifact://response"],
    ["comparison", "comparison:v-table-a:v-table-b", "energy|J"],
  ] as const)("renders and clears the effective %s descriptor selection", async (surface, descriptorId, effectiveSelection) => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      descriptorPreferences = {
        [descriptorId]: { displayUnits: { energy: "J" }, range: { fromSI: 1, toSI: 2 }, selectedSeriesIds: [effectiveSelection] },
      };
      analysisWorkspaceStore.setActiveSurface(surface);
      analysisWorkspaceStore.setSelectedDatasetRef("table-a");
      analysisWorkspaceStore.setChartState("step", ["global-dynamics-selection"]);
      if (surface === "comparison") analysisWorkspaceStore.setComparisonSelection([effectiveSelection]);
      analysisWorkspaceStore.setActiveDescriptorId(descriptorId);
      analysisWorkspaceStore.setActiveDescriptorSelection(descriptorId, [effectiveSelection]);

      await act(async () => root.render(<ChartInspectorPanel selection={analysisSelection()} />));
      expect(container.textContent).toContain(effectiveSelection);
      expect(container.textContent).not.toContain("global-dynamics-selection");

      await act(async () => findButton(container, "Clear selected series").click());
      expect(setDescriptorPreference).toHaveBeenLastCalledWith(descriptorId, {
        displayUnits: { energy: "J" },
        range: { fromSI: 1, toSI: 2 },
        selectedSeriesIds: [],
      });
      expect(analysisWorkspaceStore.getSnapshot().activeDescriptorSelectedSeriesIds).toEqual([]);
      expect(container.textContent).toContain("Seriesnone");
      if (surface === "comparison") expect(analysisWorkspaceStore.getSnapshot().comparisonSelectedSeriesKeys).toEqual([]);
      if (surface === "dynamics") expect(analysisWorkspaceStore.getSnapshot().selectedSeriesIds).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not write a preference before the controller resolves a canonical descriptor", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      analysisWorkspaceStore.setChartState("step", ["global-dynamics-selection"]);
      await act(async () => root.render(<ChartInspectorPanel selection={analysisSelection()} />));
      expect(findButton(container, "Clear selected series").hasAttribute("disabled")).toBe(true);
      expect(setDescriptorPreference).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function analysisSelection(): Parameters<typeof ChartInspectorPanel>[0]["selection"] {
  return { kind: "analysis.chart", label: "Analysis", moduleSource: "analysis-plots", nodeId: "analysis:chart", objectId: null, ref: { chartId: "chart", kind: "analysis.chart", nodeId: "analysis:chart", tableId: "table-a", type: "analysis-chart" } } as Parameters<typeof ChartInspectorPanel>[0]["selection"];
}

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) => element.tagName === "BUTTON" && element.textContent.includes(text))[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

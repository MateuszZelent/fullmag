import { beforeEach, describe, expect, it } from "vitest";

import {
  collapseExplorerNodes,
  expandExplorerNodes,
  explorerStore,
  resetExplorerStoreForTests,
  setExplorerActiveTab,
  setExplorerFilterText,
  toggleExplorerNode,
} from "./explorerStore";

describe("explorerStore", () => {
  beforeEach(() => {
    resetExplorerStoreForTests();
  });

  it("keeps active tab, filter, and expansion state as module-local UI state", () => {
    setExplorerActiveTab("resources");
    setExplorerFilterText("mesh");
    expandExplorerNodes("resources", ["resources:fields", "resources:mesh"]);
    toggleExplorerNode("resources", "resources:mesh");

    const state = explorerStore.getSnapshot();

    expect(state.activeTab).toBe("resources");
    expect(state.filterText).toBe("mesh");
    expect(state.expandedIds.resources.has("resources:fields")).toBe(true);
    expect(state.expandedIds.resources.has("resources:mesh")).toBe(false);

    collapseExplorerNodes("resources", ["resources:fields"]);
    expect(explorerStore.getSnapshot().expandedIds.resources.size).toBe(0);
  });
});

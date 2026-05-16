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

    // resources:fields is already expanded by default; add is idempotent.
    expandExplorerNodes("resources", ["resources:fields", "resources:mesh"]);
    // toggle resources:mesh OFF
    toggleExplorerNode("resources", "resources:mesh");

    const state = explorerStore.getSnapshot();

    expect(state.activeTab).toBe("resources");
    expect(state.filterText).toBe("mesh");
    expect(state.expandedIds.resources.has("resources:fields")).toBe(true);
    expect(state.expandedIds.resources.has("resources:mesh")).toBe(false);

    // Collapse resources:fields — it should no longer be expanded
    collapseExplorerNodes("resources", ["resources:fields"]);
    expect(explorerStore.getSnapshot().expandedIds.resources.has("resources:fields")).toBe(false);
    expect(explorerStore.getSnapshot().expandedIds.resources.has("resources:mesh")).toBe(false);
  });
});

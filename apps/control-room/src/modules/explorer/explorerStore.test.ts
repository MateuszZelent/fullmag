import { beforeEach, describe, expect, it } from "vitest";

import {
  collapseExplorerNodes,
  expandExplorerNodes,
  ensureExplorerModelObjectDefaults,
  explorerStore,
  revealExplorerNode,
  resetExplorerStoreForTests,
  setExplorerActiveTab,
  setExplorerFilterText,
  shouldAutoRevealModelTab,
  toggleExplorerNode,
} from "./explorerStore";

describe("explorerStore", () => {
  beforeEach(() => {
    resetExplorerStoreForTests();
  });

  it("opens Objects by default and keeps the shared Mesh branch collapsed", () => {
    const state = explorerStore.getSnapshot();

    expect(state.expandedIds.model.has("model:objects")).toBe(true);
    expect(state.expandedIds.model.has("model:mesh")).toBe(false);
  });

  it("expands dynamic model object roots once without reopening collapsed roots", () => {
    ensureExplorerModelObjectDefaults(["model:object:film"]);
    expect(explorerStore.getSnapshot().expandedIds.model.has("model:object:film")).toBe(
      true,
    );

    collapseExplorerNodes("model", ["model:object:film"]);
    ensureExplorerModelObjectDefaults([
      "model:object:film",
      "model:object:reference",
    ]);

    expect(explorerStore.getSnapshot().expandedIds.model.has("model:object:film")).toBe(
      false,
    );
    expect(
      explorerStore.getSnapshot().expandedIds.model.has("model:object:reference"),
    ).toBe(true);
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

  it("reveals a viewport selection without clearing the user's filter", () => {
    setExplorerActiveTab("results");
    setExplorerFilterText("energy");
    collapseExplorerNodes("model", ["model:session", "model:mesh"]);

    revealExplorerNode("model", "model:mesh:unassigned:part%3Aorphan", [
      "model:session",
      "model:mesh",
      "model:mesh:unassigned",
    ]);

    const state = explorerStore.getSnapshot();
    expect(state.activeTab).toBe("model");
    expect(state.filterText).toBe("energy");
    expect(state.keyboardRow).toBe("model:mesh:unassigned:part%3Aorphan");
    expect(state.expandedIds.model.has("model:session")).toBe(true);
    expect(state.expandedIds.model.has("model:mesh")).toBe(true);
    expect(state.expandedIds.model.has("model:mesh:unassigned")).toBe(true);
  });

  it("does not force the Model tab when the user changes tabs without changing selection", () => {
    expect(shouldAutoRevealModelTab("model:physics", "model:physics", "results")).toBe(false);
    expect(shouldAutoRevealModelTab("results:field:m", "model:physics", "results")).toBe(true);
  });
});

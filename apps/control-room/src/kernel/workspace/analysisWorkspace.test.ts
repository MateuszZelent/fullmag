import { describe, expect, it } from "vitest";

import { analysisWorkspaceStore, resetAnalysisWorkspaceForTests } from "./analysisWorkspace";

describe("analysis workspace", () => {
  it("keeps source selection as a small explicit identifier", () => {
    resetAnalysisWorkspaceForTests();
    analysisWorkspaceStore.setSelectedDatasetRef("table:run-7:stage-2:table-4");

    expect(analysisWorkspaceStore.getSnapshot().selectedDatasetRef).toBe("table:run-7:stage-2:table-4");

    analysisWorkspaceStore.setSelectedDatasetRef("x".repeat(300));
    expect(analysisWorkspaceStore.getSnapshot().selectedDatasetRef).toBeNull();
  });
});

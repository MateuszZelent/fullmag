import { describe, expect, it } from "vitest";

import { meshWorkspaceNodeToDockTab, meshWorkspaceNodeToPreset } from "../meshWorkspace";

describe("mesh workspace routing", () => {
  it("does not route statistics nodes through a viewport dock tab", () => {
    expect(meshWorkspaceNodeToDockTab("mesh-statistics")).toBeNull();
    expect(meshWorkspaceNodeToDockTab("universe-mesh-statistics")).toBeNull();
    expect(meshWorkspaceNodeToPreset("mesh-statistics")).toBeNull();
    expect(meshWorkspaceNodeToPreset("universe-mesh-statistics")).toBeNull();
  });

  it("keeps mesh view nodes routed to the view dock tab", () => {
    expect(meshWorkspaceNodeToDockTab("mesh-view")).toBe("view");
    expect(meshWorkspaceNodeToDockTab("universe-mesh-view")).toBe("view");
  });
});

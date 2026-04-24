import { describe, expect, it } from "vitest";

import { shouldRenderWorkspaceTabPanel } from "../tabRenderPolicy";

describe("workspace center tab render policy", () => {
  it("renders only the active tab panel", () => {
    expect(shouldRenderWorkspaceTabPanel({ id: "core:3d" }, "core:3d")).toBe(true);
    expect(shouldRenderWorkspaceTabPanel({ id: "core:3d" }, "core:charts")).toBe(false);
    expect(shouldRenderWorkspaceTabPanel({ id: "core:charts" }, "core:3d")).toBe(false);
    expect(shouldRenderWorkspaceTabPanel({ id: "core:charts" }, null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  coreTabIdForWorkspaceRouteSlug,
  normalizeWorkspaceTabSlug,
  workspaceHrefForTabSlug,
  workspaceRouteSlugForTab,
} from "../workspace-route";

describe("workspace tab route helpers", () => {
  it("normalizes canonical and legacy tab slugs", () => {
    expect(normalizeWorkspaceTabSlug("3d")).toBe("3d");
    expect(normalizeWorkspaceTabSlug("viewport-2d")).toBe("2d");
    expect(normalizeWorkspaceTabSlug(["mesh-workspace"])).toBe("mesh");
    expect(normalizeWorkspaceTabSlug("analysis")).toBe("analyze");
    expect(normalizeWorkspaceTabSlug("plots")).toBe("charts");
    expect(normalizeWorkspaceTabSlug("unknown")).toBeNull();
  });

  it("maps route slugs to stable core tabs and hrefs", () => {
    expect(coreTabIdForWorkspaceRouteSlug("charts")).toBe("core:charts");
    expect(workspaceHrefForTabSlug("charts")).toBe("/workspace/charts");
  });

  it("maps workspace tabs back to route slugs", () => {
    expect(workspaceRouteSlugForTab({ id: "core:3d", kind: "viewport-3d" })).toBe("3d");
    expect(workspaceRouteSlugForTab({ id: "core:charts", kind: "viewport-charts" })).toBe(
      "charts",
    );
    expect(workspaceRouteSlugForTab({ id: "result:spectrum", kind: "result-spectrum" })).toBe(
      "analyze",
    );
  });
});

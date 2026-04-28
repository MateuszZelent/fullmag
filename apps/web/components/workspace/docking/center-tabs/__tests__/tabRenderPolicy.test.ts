import { describe, expect, it } from "vitest";

import { shouldRenderWorkspaceTabPanel } from "../tabRenderPolicy";

describe("workspace center tab render policy", () => {
  it("keeps warm viewport tabs mounted while preserving cold tabs as active-only", () => {
    expect(shouldRenderWorkspaceTabPanel({ id: "core:3d", lifecycle: "warm" }, "core:3d")).toBe(
      true,
    );
    expect(
      shouldRenderWorkspaceTabPanel({ id: "core:3d", lifecycle: "warm" }, "core:charts"),
    ).toBe(true);
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:charts", lifecycle: "unmount-on-hide" },
        "core:3d",
      ),
    ).toBe(false);
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:charts", lifecycle: "unmount-on-hide" },
        "core:charts",
      ),
    ).toBe(true);
    expect(shouldRenderWorkspaceTabPanel({ id: "core:3d", lifecycle: "warm" }, null)).toBe(
      false,
    );
  });
});

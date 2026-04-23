import { describe, expect, it } from "vitest";

import { mapRouteFlagsToViewport3DStages } from "../viewport3dFlags";

describe("mapRouteFlagsToViewport3DStages", () => {
  it("maps legacy route flags to stage flags", () => {
    const stages = mapRouteFlagsToViewport3DStages({
      enableUnifiedViewport3D: true,
      enableUnifiedViewportToolbar: true,
    });

    expect(stages.viewport3d_unified_model).toBe(true);
    expect(stages.viewport3d_unified_toolbar).toBe(true);
    expect(stages.viewport3d_unified_fdm_modules).toBe(true);
    expect(stages.viewport3d_unified_cutover).toBe(true);
  });

  it("marks cutover as complete when unified 3D routing is on", () => {
    const stages = mapRouteFlagsToViewport3DStages({
      enableUnifiedViewport3D: true,
      enableUnifiedViewportToolbar: false,
    });

    expect(stages.viewport3d_unified_routing).toBe(true);
    expect(stages.viewport3d_unified_cutover).toBe(true);
  });
});

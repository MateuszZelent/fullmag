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
    expect(stages.viewport3d_unified_fdm_modules).toBe(false);
    expect(stages.viewport3d_unified_cutover).toBe(false);
  });

  it("keeps cutover false when unified 3D routing is on but legacy renderers remain", () => {
    const stages = mapRouteFlagsToViewport3DStages({
      enableUnifiedViewport3D: true,
      enableUnifiedViewportToolbar: false,
    });

    expect(stages.viewport3d_unified_routing).toBe(true);
    expect(stages.viewport3d_unified_cutover).toBe(false);
  });

  it("marks cutover complete only from the explicit cutover flag", () => {
    const stages = mapRouteFlagsToViewport3DStages({
      enableUnifiedViewport3D: true,
      enableUnifiedViewportToolbar: false,
      enableUnifiedViewportCutover: true,
    });

    expect(stages.viewport3d_unified_routing).toBe(true);
    expect(stages.viewport3d_unified_fdm_modules).toBe(true);
    expect(stages.viewport3d_unified_cutover).toBe(true);
  });
});

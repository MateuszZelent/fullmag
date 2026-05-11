import { describe, expect, it } from "vitest";

import { resolveOrientationHudAnchors } from "./hudLayout";

describe("orientation HUD layout", () => {
  it("keeps the 3D box in the top-right and the HSL reference in the bottom-left", () => {
    expect(resolveOrientationHudAnchors({ height: 600, width: 800 })).toEqual({
      hslReference: [-304, -204, 0],
      viewCube: [314, 214, 0],
    });
  });
});

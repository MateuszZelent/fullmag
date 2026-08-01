import { describe, expect, it } from "vitest";

import { resolveFieldMapCapabilities } from "./fieldMapCapabilities";

describe("field-map capabilities", () => {
  it("returns stable reasons instead of enabled controls that do nothing", () => {
    expect(
      resolveFieldMapCapabilities({
        meshOverlayAvailable: false,
        spatial: false,
        vectorComponents: 0,
      }),
    ).toEqual({
      contours: { enabled: false, reasonCode: "quantity_not_spatial" },
      mesh: { enabled: false, reasonCode: "mesh_overlay_unavailable" },
      vectors: { enabled: false, reasonCode: "quantity_not_spatial" },
    });
  });
});

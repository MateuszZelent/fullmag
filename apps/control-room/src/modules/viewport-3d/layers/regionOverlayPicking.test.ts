import { describe, expect, it } from "vitest";
import { Mesh, Object3D } from "three";

import { eventIntersectsRegionOverlay } from "./regionOverlayPicking";

describe("regionOverlayPicking", () => {
  it("detects region overlay hits through parent object names", () => {
    const fdmSurface = new Mesh();
    const regionGroup = new Object3D();
    const regionSurface = new Mesh();

    regionGroup.name = "region-overlay:film:core";
    regionGroup.add(regionSurface);

    expect(
      eventIntersectsRegionOverlay({
        intersections: [
          { object: fdmSurface },
          { object: regionSurface },
        ],
      }),
    ).toBe(true);
  });

  it("ignores ordinary mesh intersections", () => {
    expect(
      eventIntersectsRegionOverlay({
        intersections: [{ object: new Mesh() }],
      }),
    ).toBe(false);
  });
});

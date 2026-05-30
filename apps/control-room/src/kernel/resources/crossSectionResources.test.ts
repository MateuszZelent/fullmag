import { describe, expect, it } from "vitest";

import {
  MESHING_SHARED_DOMAIN_CROSS_SECTION_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_QUALITY_PATH,
} from "../api/apiPaths";

import {
  resolveCrossSectionQualityResourceKey,
  resolveCrossSectionResourceKey,
} from "./crossSectionResources";

describe("cross-section resources", () => {
  it("uses canonical v2 resource paths plus query and revision as cache keys", () => {
    expect(
      resolveCrossSectionResourceKey(
        {
          includePolygons: true,
          includeWireframe: false,
          plane: "xz",
          positionPercent: 25,
        },
        42,
      ),
    ).toBe(
      `${MESHING_SHARED_DOMAIN_CROSS_SECTION_PATH}?include_polygons=true&include_wireframe=false&plane=xz&position_percent=25#revision=42`,
    );
    expect(
      resolveCrossSectionQualityResourceKey(
        {
          metric: "gamma",
          plane: "xy",
          positionPercent: 50,
        },
        '"mesh-etag"',
      ),
    ).toBe(
      `${MESHING_SHARED_DOMAIN_CROSS_SECTION_QUALITY_PATH}?metric=gamma&plane=xy&position_percent=50#revision=%22mesh-etag%22`,
    );
  });
});

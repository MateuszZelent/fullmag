import { describe, expect, it } from "vitest";

import {
  MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_PATH,
  MESHING_SHARED_DOMAIN_CROSS_SECTION_QUALITY_PATH,
} from "../api/apiPaths";

import {
  resolveCrossSectionImageResourceKey,
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
    expect(
      resolveCrossSectionImageResourceKey(
        {
          colorScale: "coolwarm",
          filterExpression: ">=0.1",
          legend: false,
          metric: "sicn",
          plane: "yz",
          positionPercent: 75,
          resolution: 2048,
          rotationDegrees: 17,
          shrinkFactor: 0.95,
          wireframe: true,
        },
        "image-rev",
      ),
    ).toBe(
      `${MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH}?color_scale=coolwarm&filter_expression=%3E%3D0.1&legend=false&metric=sicn&plane=yz&position_percent=75&resolution=2048&rotation_degrees=17&shrink_factor=0.95&wireframe=true&edge_width=1.5&dpr=1#revision=image-rev`,
    );
  });
});

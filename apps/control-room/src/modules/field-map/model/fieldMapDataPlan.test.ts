import { describe, expect, it } from "vitest";

import { buildFieldMapDataPlan } from "./fieldMapDataPlan";

describe("field-map data plan", () => {
  it("does not enable planar requests for an inactive module", () => {
    expect(
      buildFieldMapDataPlan({
        active: false,
        component: "normal",
        includeMesh: true,
        monitorId: "plane-1",
        quantityId: "m",
        resolution: [512, 256],
        showVectors: true,
      }),
    ).toMatchObject({
      enabled: false,
      requestMask: false,
      requestMesh: false,
      requestScalar: false,
      requestVectors: false,
    });
  });

  it("requests only selected layers with bounded interactive parameters", () => {
    const plan = buildFieldMapDataPlan({
      active: true,
      component: "normal",
      includeMesh: false,
      monitorId: "plane-1",
      quantityId: "m",
      resolution: [512, 256],
      showVectors: true,
    });
    expect(plan).toMatchObject({
      enabled: true,
      requestMesh: false,
      requestScalar: true,
      requestVectors: true,
      query: {
        quality: "interactive",
        resolution_x: 512,
        resolution_y: 256,
        vector_budget: 2_000,
      },
    });
  });
});

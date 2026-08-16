import { describe, expect, it } from "vitest";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";

describe("planar visualization profile contract", () => {
  it("keeps planar changes structurally independent from the 3D profile", () => {
    const patch = {
      planar: {
        source: { kind: "monitor", monitor_id: "plane-1" },
        component: "normal",
        quantity_id: "h_demag",
      },
    } satisfies VisualizationStatePatch;

    expect(patch).not.toHaveProperty("quantity");
    expect(patch).not.toHaveProperty("layers");
    expect(patch).not.toHaveProperty("camera");
  });

  it("generates a required planar branch on the visualization resource", () => {
    type Planar = NonNullable<VisualizationStateResource["planar"]>;
    const profile: Pick<Planar, "component" | "quantity_id"> = {
      component: "magnitude",
      quantity_id: "m",
    };
    expect(profile).toEqual({ component: "magnitude", quantity_id: "m" });
  });
});

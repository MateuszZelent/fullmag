import { describe, expect, it } from "vitest";

import { METRIC_ANALYTIC_PRESETS } from "../../../../lib/magnetizationPresetCatalog";
import { fitPresetParamsToBounds, textureScaleSemantics } from "../../../../lib/textureTransform";

describe("legacy bimeron compatibility metadata", () => {
  it("keeps bimeron metric and fits physical dimensions in the plane", () => {
    expect(METRIC_ANALYTIC_PRESETS.has("bimeron")).toBe(true);
    expect(textureScaleSemantics("bimeron")).toBe("identity_metric");

    const result = fitPresetParamsToBounds(
      "bimeron",
      { plane: "xz" },
      [-50e-9, -20e-9, -5e-9],
      [50e-9, 20e-9, 5e-9],
    );

    expect(result.params.radius).toBe(4e-9);
    expect(result.params.wall_width).toBe(1e-9);
    expect(result.transform.scale).toEqual([1, 1, 1]);
  });
});


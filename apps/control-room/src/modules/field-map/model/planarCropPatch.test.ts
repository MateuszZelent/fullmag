import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import { withStalePlanarCropCleared } from "./planarCropPatch";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;

const crop = { u_min_m: -1e-8, u_max_m: 1e-8, v_min_m: 0, v_max_m: 2e-8 };
const slice = { operator: { kind: "plane_sample" }, plane: "xy", position_fraction: 0.5 };
const planar = { crop, default_slice: slice, source: { kind: "default" } } as unknown as PlanarState;

describe("withStalePlanarCropCleared (Review Focus 3)", () => {
  it("clears the crop in the same patch as a plane change", () => {
    const patch = withStalePlanarCropCleared(planar, { default_slice: { ...slice, plane: "yz" } } as never);
    expect(patch).toMatchObject({ crop: null });
    expect(JSON.stringify(patch)).not.toContain(String(crop.u_max_m));
  });

  it("clears the crop when the source changes", () => {
    expect(withStalePlanarCropCleared(planar, { source: { kind: "monitor", monitor_id: "plane-1" } } as never))
      .toMatchObject({ crop: null });
  });

  it("keeps the crop for a position step on the same plane and without a crop", () => {
    const step = { default_slice: { ...slice, position_fraction: 0.6 } } as never;
    expect(withStalePlanarCropCleared(planar, step)).not.toHaveProperty("crop");
    expect(withStalePlanarCropCleared({ ...planar, crop: null }, { default_slice: { ...slice, plane: "yz" } } as never))
      .not.toHaveProperty("crop");
  });

  it("does not override a crop the patch sets itself", () => {
    const next = { ...crop, u_max_m: 5e-9 };
    expect(withStalePlanarCropCleared(planar, { crop: next, source: { kind: "default" } } as never))
      .toMatchObject({ crop: next });
  });
});

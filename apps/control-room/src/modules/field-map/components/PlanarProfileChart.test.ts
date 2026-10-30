import { describe, expect, it } from "vitest";

import type { PlanarFieldProfileResource } from "@/kernel/api/apiTypes";

import { planarProfileChartModel } from "./PlanarProfileChart";

function point(
  s_m: number,
  scalar: number | null,
  vector: [number, number, number] | null,
  occupancy = scalar === null ? "empty" : "occupied",
): PlanarFieldProfileResource["points"][number] {
  return { entity_id: null, kind: "uniform", occupancy, s_m, scalar, u_m: s_m, v_m: 0, vector };
}

const profile = {
  component: "magnitude",
  length_m: 4e-9,
  points: [
    point(0, 1, [1, 0, 0]),
    point(1e-9, 1, [0, 1, 0]),
    point(2e-9, null, null),
    point(3e-9, 2, [0, 0, 2]),
    point(4e-9, 2, [0, 0, 2]),
  ],
  quantity_id: "m",
  sample_token: "planar-sample-v3:abc",
  sampling_method: "line_profile",
  source: { kind: "default" },
  source_entity_kind: "element",
  u0_m: 0,
  u1_m: 4e-9,
  v0_m: 0,
  v1_m: 0,
} as unknown as PlanarFieldProfileResource;

describe("line profile chart model", () => {
  it("plots the scalar and vector components against arc length and breaks at empty points", () => {
    const model = planarProfileChartModel(
      profile,
      { lengthScale: 1e9, lengthUnit: "nm", legendUnit: "", probeScale: 1 },
      "Magnetization",
    );
    expect(model.status).toBe("ready");
    expect(model.series.map((series) => series.id)).toEqual(["scalar", "x", "y", "z"]);
    const scalar = model.series[0]!;
    expect(scalar.points.map((p) => [p.x, p.y])).toEqual([[0, 1], [1, 1], [3, 2], [4, 2]]);
    expect(scalar.points[2]!.breakBefore).toBe(true);
    expect(scalar.points[1]!.breakBefore).toBe(false);
    expect(model.series[3]!.points.map((p) => p.y)).toEqual([0, 0, 2, 2]);
    expect(model.xAxis).toEqual({ label: "Arc length s", unit: "nm" });
  });

  it("reports an empty profile when the segment misses the target", () => {
    const model = planarProfileChartModel(
      { ...profile, points: [point(0, null, null), point(1e-9, null, null)] },
      { lengthScale: 1, lengthUnit: "m", legendUnit: "A/m", probeScale: 1 },
      "H",
    );
    expect(model.status).toBe("empty");
  });
});

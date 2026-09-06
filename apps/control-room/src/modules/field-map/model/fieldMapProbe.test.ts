import { describe, expect, it } from "vitest";

import { localProbe, probeWorldCoordinate } from "./fieldMapProbe";

describe("field-map probes", () => {
  it("resolves local hover without a backend request", () => {
    expect(localProbe(0.75, 0.25, [0, 1, 0, 1], [2, 2], [1, 2, 3, 4])).toEqual({
      index: 1,
      occupancy: "occupied",
      value: 2,
    });
    expect(
      localProbe(0.75, 0.25, [0, 1, 0, 1], [2, 2], [1, 2, 3, 4], [0, 1, 0, 0]),
    ).toMatchObject({ occupancy: "empty", value: null });
    expect(
      localProbe(0.75, 0.25, [0, 1, 0, 1], [2, 2], [1, 2, 3, 4], [0, 4, 0, 0]),
    ).toMatchObject({ occupancy: "overlap_ambiguous", value: 2 });
  });

  it("maps a pinned planar probe into exact world coordinates", () => {
    expect(
      probeWorldCoordinate(2, 3, {
        origin: [10, 20, 30],
        uAxis: [0, 1, 0],
        vAxis: [0, 0, 1],
      }),
    ).toEqual([10, 22, 33]);
  });

  it("returns outside_extent and null value when probe coordinate is outside bounds", () => {
    expect(localProbe(-0.1, 0.5, [0, 1, 0, 1], [2, 2], [1, 2, 3, 4])).toEqual({
      index: -1,
      occupancy: "outside_extent",
      value: null,
    });
    expect(localProbe(1.5, 0.5, [0, 1, 0, 1], [2, 2], [1, 2, 3, 4])).toEqual({
      index: -1,
      occupancy: "outside_extent",
      value: null,
    });
  });
});

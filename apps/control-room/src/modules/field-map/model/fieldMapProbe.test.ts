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

  it("evaluates continuous probe without raster discretization error", () => {
    // 16 columns from 0 to 1, values = cell centers (u = (x + 0.5) / 16)
    const n = 16;
    const values = new Float64Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        values[r * n + c] = (c + 0.5) / n;
      }
    }
    // At u = 0.26, continuous probe should interpolate linearly to 0.26
    const probe = localProbe(0.26, 0.5, [0, 1, 0, 1], [n, n], values, undefined, {
      continuous: true,
      probeKind: "continuous_evaluation",
    });
    expect(probe.probeKind).toBe("continuous_evaluation");
    expect(probe.value).toBeCloseTo(0.26, 5);
    expect(probe.requestedPoint).toEqual([0.26, 0.5]);
  });

  it("continuous probe normalizes only over occupied cells and avoids bleeding vacuum zeros", () => {
    // 4x4 grid: right half (cols 2, 3) is occupied with constant 10.0, left half is empty (0.0)
    const n = 4;
    const values = new Float64Array(n * n);
    const mask = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const idx = r * n + c;
        if (c >= 2) {
          values[idx] = 10.0;
          mask[idx] = 0; // PLANAR_OCCUPANCY.occupied (0)
        } else {
          values[idx] = 0.0;
          mask[idx] = 1; // PLANAR_OCCUPANCY.empty (1)
        }
      }
    }
    // Probe on the right side at u = 0.6 (between col 2 center 0.625 and boundary 0.5)
    const probe = localProbe(0.6, 0.5, [0, 1, 0, 1], [n, n], values, mask, {
      continuous: true,
      probeKind: "continuous_evaluation",
    });
    expect(probe.probeKind).toBe("continuous_evaluation");
    expect(probe.occupancy).toBe("occupied");
    // Must remain 10.0, not contaminated by 0.0 in col 1
    expect(probe.value).toBeCloseTo(10.0, 5);
  });

  it("extrapolates linearly to domain boundaries without clamping to cell centers (TS13, TS16)", () => {
    const n = 16;
    const values = new Float64Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        values[r * n + c] = (c + 0.5) / n;
      }
    }
    const probeMin = localProbe(0.0, 0.5, [0, 1, 0, 1], [n, n], values, undefined, {
      continuous: true,
    });
    expect(probeMin.probeKind).toBe("interpolated_raster_preview");
    expect(probeMin.value).toBeCloseTo(0.0, 5);
    expect(probeMin.sampledPoint).toEqual([0.0, 0.5]);

    const probeMax = localProbe(1.0, 0.5, [0, 1, 0, 1], [n, n], values, undefined, {
      continuous: true,
    });
    expect(probeMax.probeKind).toBe("interpolated_raster_preview");
    expect(probeMax.value).toBeCloseTo(1.0, 5);
    expect(probeMax.sampledPoint).toEqual([1.0, 0.5]);
  });
});

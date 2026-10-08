import { describe, expect, it } from "vitest";
import { availableDispersionAxes, defaultDispersionAxis, projectDispersionSeries } from "./dispersionChartAxes";
import type { ChartSeries } from "./chartSeries";

const base: ChartSeries = {
  id: "branch-1", label: "Branch 1", quantity: "frequency", status: "ready", unit: "Hz", xUnit: "rad/m", kind: "line",
  source: { kind: "analysis.frequency_domain", tableId: "frequency-domain:eigen-dispersion", resourceKey: "dispersion" },
  points: [
    { rowIndex: 7, x: 0, y: 12e9, wavevectorRadPerM: [0, -25e6, 0], sampleIndex: 0, modeIndex: 0, branchId: "one", itemId: "mode-negative" },
    { rowIndex: 2, x: 25e6, y: 9e9, wavevectorRadPerM: [0, 0, 0], sampleIndex: 1, modeIndex: 0, branchId: "one", itemId: "mode-zero" },
    { rowIndex: 9, x: 50e6, y: 12e9, wavevectorRadPerM: [0, 25e6, 0], sampleIndex: 2, modeIndex: 0, branchId: "one", itemId: "mode-positive", breakBefore: true },
  ],
};

describe("physical dispersion coordinates", () => {
  it("chooses the only varying physical component and preserves signed k in SI", () => {
    expect(defaultDispersionAxis([base])).toBe("ky");
    const projected = projectDispersionSeries([base], "ky")[0]!;
    expect(projected.points.map((p) => p.x)).toEqual([-25e6, 0, 25e6]);
    expect(projected.xUnit).toBe("rad/m");
    expect(projected.points.map((p) => p.rowIndex)).toEqual([7, 2, 9]);
    expect(projected.points[2]?.breakBefore).toBe(true);
    expect(base.points.map((p) => p.x)).toEqual([0, 25e6, 50e6]);
  });
  it("keeps multidirectional paths on path distance by default", () => {
    const path = { ...base, points: base.points.map((p, i) => ({ ...p, wavevectorRadPerM: [i * 1e6, p.wavevectorRadPerM![1], 0] as const })) };
    expect(defaultDispersionAxis([path])).toBe("path");
  });
  it("does not manufacture signed vectors from path distance", () => {
    const missing = { ...base, points: base.points.map((p) => ({ ...p, wavevectorRadPerM: null })) };
    expect(availableDispersionAxes([missing])).toEqual(["path"]);
    expect(defaultDispersionAxis([missing])).toBe("path");
    expect(() => projectDispersionSeries([missing], "ky")).toThrow(RangeError);
  });
  it("rejects incomplete and nonfinite vectors rather than dropping points", () => {
    const partial = { ...base, points: [base.points[0]!, { ...base.points[1]!, wavevectorRadPerM: [0, NaN, 0] as const }] };
    expect(availableDispersionAxes([partial])).toEqual(["path"]);
  });
  it("preserves crossing order, branch identities and selected point metadata", () => {
    const repeated = { ...base, points: [base.points[2]!, base.points[0]!, base.points[2]!] };
    const selected = { label: base.label, point: base.points[0]!, quantity: base.quantity, seriesId: base.id, source: base.source, unit: base.unit, xUnit: base.xUnit };
    const projected = projectDispersionSeries([repeated], "ky", selected)[0]!;
    expect(projected.points.map((p) => p.x)).toEqual([25e6, -25e6, 25e6]);
    expect(projected.points.map((p) => p.itemId)).toEqual(["mode-positive", "mode-negative", "mode-positive"]);
    expect(projected.points.map((p) => p.selected)).toEqual([false, true, false]);
    expect(projected.points[1]?.rowIndex).toBe(7);
    expect(projected.points[1]?.wavevectorRadPerM).toEqual([0, -25e6, 0]);
    expect(projected.xAxisLabel).toBe("kᵧ");
  });
});

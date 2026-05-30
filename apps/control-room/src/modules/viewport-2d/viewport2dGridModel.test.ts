import { describe, expect, it } from "vitest";

import { buildViewport2DGridModel } from "./viewport2dGridModel";

describe("buildViewport2DGridModel", () => {
  it("builds nice u and v grid ticks within the cross-section bounds", () => {
    const model = buildViewport2DGridModel(
      { uMax: 10, uMin: 0, vMax: 5, vMin: -5 },
      { targetTickCount: 5 },
    );

    expect(model.uTicks.map((tick) => tick.value)).toEqual([
      0, 2, 4, 6, 8, 10,
    ]);
    expect(model.vTicks.map((tick) => tick.value)).toEqual([-4, -2, 0, 2, 4]);
    expect(model.lineCount).toBe(11);
    expect(model.positions).toHaveLength(model.lineCount * 6);
    expect(model.colors).toHaveLength(model.lineCount * 6);
  });

  it("marks zero-coordinate ticks as axis lines", () => {
    const model = buildViewport2DGridModel(
      { uMax: 1, uMin: -1, vMax: 1, vMin: -1 },
      { targetTickCount: 4 },
    );

    expect(model.uTicks.find((tick) => tick.value === 0)).toMatchObject({
      label: "0",
      role: "axis",
    });
    expect(model.vTicks.find((tick) => tick.value === 0)).toMatchObject({
      label: "0",
      role: "axis",
    });
  });

  it("normalizes degenerate bounds before generating grid buffers", () => {
    const model = buildViewport2DGridModel(
      { uMax: 4, uMin: 4, vMax: 2, vMin: 2 },
      { targetTickCount: 2 },
    );

    expect(model.lineCount).toBeGreaterThan(0);
    expect(model.positions[0]).toBeGreaterThan(3);
    expect(model.positions[1]).toBeGreaterThan(1);
    expect(model.positions[2]).toBeCloseTo(-0.02);
    expect(model.positions[3]).toBeGreaterThan(3);
    expect(model.positions[4]).toBeGreaterThan(1);
    expect(model.positions[5]).toBeCloseTo(-0.02);
  });
});

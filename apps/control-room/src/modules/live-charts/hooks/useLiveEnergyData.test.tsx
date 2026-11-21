import { describe, expect, it } from "vitest";

import { buildLiveEnergyChartData, isLiveEnergyLoadEnabled } from "./useLiveEnergyData";

function energyRow(step: number, time_seconds: number, total: number) {
  return {
    step,
    time_seconds,
    exchange: total,
    demag: 0,
    zeeman: 0,
    anisotropy: 0,
    dmi: 0,
    total,
  };
}

describe("useLiveEnergyData", () => {
  it("loads energy only for an active following Energy preset", () => {
    expect(isLiveEnergyLoadEnabled({ active: true, descriptorId: "energy", paused: false })).toBe(true);
    expect(isLiveEnergyLoadEnabled({ active: false, descriptorId: "energy", paused: false })).toBe(false);
    expect(isLiveEnergyLoadEnabled({ active: true, descriptorId: "energy", paused: true })).toBe(false);
  });

  it.each([0, 2.5e-9])(
    "uses each solver step for an iterative history with a constant clock (%s s)",
    (fixedTime) => {
      const chart = buildLiveEnergyChartData({
        rows: [energyRow(4, fixedTime, -3), energyRow(9, fixedTime, -5)],
      }, "ready");
      const total = chart.series.find((item) => item.quantity === "total");

      expect(chart.xAxisId).toBe("step");
      expect(total).toMatchObject({
        xUnit: "1",
        points: [
          { rowIndex: 0, x: 4, y: -3 },
          { rowIndex: 1, x: 9, y: -5 },
        ],
      });
    },
  );

  it("keeps dynamics on time when the solver clock advances", () => {
    const chart = buildLiveEnergyChartData({
      rows: [energyRow(4, 2.5e-9, -3), energyRow(5, 3e-9, -5)],
    }, "ready");
    const total = chart.series.find((item) => item.quantity === "total");

    expect(chart.xAxisId).toBe("t");
    expect(total).toMatchObject({
      xUnit: "s",
      points: [
        { rowIndex: 0, x: 2.5e-9, y: -3 },
        { rowIndex: 1, x: 3e-9, y: -5 },
      ],
    });
  });

  it("keeps the time axis until multiple increasing step samples establish a relaxation history", () => {
    expect(buildLiveEnergyChartData({ rows: [energyRow(4, 0, -3)] }, "ready").xAxisId).toBe("t");
    expect(buildLiveEnergyChartData({
      rows: [energyRow(4, 0, -3), energyRow(4, 0, -5)],
    }, "ready").xAxisId).toBe("t");
    expect(buildLiveEnergyChartData({
      rows: [energyRow(5, 0, -3), energyRow(4, 0, -5)],
    }, "ready").xAxisId).toBe("t");
  });
});

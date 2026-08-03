import { describe, expect, it } from "vitest";

import {
  buildLiveChartsTableQuery,
  compatibleLiveChartPanes,
  liveChartDescriptorDefaults,
  liveChartPreset,
} from "./liveChartsModel";

describe("liveChartsModel", () => {
  it.each(["magnetization", "energy", "convergence", "custom"] as const)("describes the %s preset", (id) => {
    expect(liveChartPreset(id).id).toBe(id);
  });

  it("keeps incompatible custom units in labelled panes", () => {
    expect(compatibleLiveChartPanes([
      { id: "mx", label: "mx", unit: "1" },
      { id: "e_total", label: "E total", unit: "J" },
    ])).toEqual([
      { label: "Dimensionless", seriesIds: ["mx"], unit: "1" },
      { label: "J", seriesIds: ["e_total"], unit: "J" },
    ]);
  });

  it("seeds each absent preset with its own canonical axes and series", () => {
    expect(liveChartDescriptorDefaults("energy")).toMatchObject({
      xAxisId: "t",
      selectedSeriesIds: [
        "simulation.solver.energies:exchange",
        "simulation.solver.energies:demag",
        "simulation.solver.energies:zeeman",
        "simulation.solver.energies:anisotropy",
        "simulation.solver.energies:dmi",
        "simulation.solver.energies:total",
      ],
    });
    expect(liveChartDescriptorDefaults("convergence")).toMatchObject({
      xAxisId: "step",
      selectedSeriesIds: ["max_torque_Apm"],
    });
  });

  it("maps Tail rows, Tail time, Fixed range, and Full decimated to bounded queries", () => {
    expect(buildLiveChartsTableQuery({ columns: ["step", "mx"], cursor: 12, latestX: 4e-9, range: { mode: "tailRows", rows: 120 }, targetPoints: 800, xAxisId: "step" })).toMatchObject({ includeTail: true, limit: 120, targetPoints: 120 });
    const tailTime = buildLiveChartsTableQuery({ columns: ["t", "mx"], cursor: 12, latestX: 4e-9, range: { mode: "tailTime", durationS: 1e-9 }, targetPoints: 800, xAxisId: "t" });
    expect(tailTime).toMatchObject({ toT: 4e-9, includeTail: false });
    expect(tailTime.fromT).toBeCloseTo(3e-9);
    expect(buildLiveChartsTableQuery({ columns: ["step", "mx"], cursor: 12, latestX: 10, range: { mode: "fixed", fromSI: 3, toSI: 8 }, targetPoints: 800, xAxisId: "step" })).toMatchObject({ fromRow: 3, toRow: 8, includeTail: false });
    expect(buildLiveChartsTableQuery({ columns: ["step", "mx"], cursor: 12, latestX: 10, range: { mode: "fullDecimated" }, targetPoints: 800, xAxisId: "step" })).toMatchObject({ includeTail: false, limit: 800, targetPoints: 800 });
  });
});

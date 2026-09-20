import { describe, expect, it } from "vitest";

import {
  buildLiveChartsTableQuery,
  compatibleLiveChartPanes,
  liveChartDescriptorDefaults,
  liveChartInitialRange,
  liveChartPreset,
  liveChartQuerySemantic,
  normalizeLiveChartRangeForXAxis,
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
    expect(liveChartInitialRange({ mode: "fixed", fromSI: 8, toSI: 3 })).toEqual({ fromValue: 3, toValue: 8 });
    expect(buildLiveChartsTableQuery({ columns: ["step", "mx"], cursor: 12, latestX: 10, range: { mode: "fullDecimated" }, targetPoints: 800, xAxisId: "step" })).toMatchObject({ includeTail: false, limit: 800, targetPoints: 800 });
  });

  it("keeps fixed step values out of row-cursor bounds after request normalization", () => {
    const range = { mode: "fixed", fromSI: 200, toSI: 300 } as const;
    const normalized = normalizeLiveChartRangeForXAxis(range, "step");
    const query = buildLiveChartsTableQuery({ columns: ["step", "mx"], cursor: 12, latestX: 300, range, targetPoints: 800, xAxisId: "step" });

    expect(normalized).toEqual({ mode: "fullDecimated" });
    expect(query).toMatchObject({ cursor: undefined, includeTail: false, limit: 50_000, targetPoints: 800 });
    expect(query.fromRow).toBeUndefined();
    expect(query.toRow).toBeUndefined();
  });

  it("keeps fixed non-time and explicit full-decimation query semantics distinct", () => {
    const fixed = liveChartQuerySemantic({ mode: "fixed", fromSI: 200, toSI: 300 }, 800, "step");
    const full = liveChartQuerySemantic({ mode: "fullDecimated" }, 800, "step");

    expect(fixed).toMatchObject({ limit: 50_000, mode: "fixedNonTimeWindow", targetPoints: 800 });
    expect(full).toMatchObject({ limit: 800, mode: "fullDecimated", targetPoints: 800 });
    expect(JSON.stringify(fixed)).not.toBe(JSON.stringify(full));
  });
});

import { describe, expect, it } from "vitest";

import {
  buildLiveChartsTableQuery,
  compatibleLiveChartPanes,
  liveChartDescriptorDefaults,
  liveChartPreset,
  normalizeLiveChartRangeForXAxis,
  resolveLiveChartAxisAndRange,
  resolveLiveChartXAxisId,
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
    const tailRows = buildLiveChartsTableQuery({ columns: ["step", "mx"], cursor: 12, latestX: 4e-9, range: { mode: "tailRows", rows: 120 }, targetPoints: 800, xAxisId: "step" });
    expect(tailRows).toMatchObject({ cursor: undefined, includeTail: true, limit: 120, targetPoints: 120 });
    expect(tailRows.cursor).toBeUndefined();
    const tailTime = buildLiveChartsTableQuery({ columns: ["t", "mx"], cursor: 12, latestX: 4e-9, range: { mode: "tailTime", durationS: 1e-9 }, targetPoints: 800, xAxisId: "t" });
    expect(tailTime).toMatchObject({ includeTail: false, limit: 5_000 });
    expect(tailTime.fromT).toBeCloseTo(3e-9);
    expect(tailTime.toT).toBeUndefined();
    const stepFixed = buildLiveChartsTableQuery({ columns: ["step", "mx"], cursor: 12, latestX: 10, range: { mode: "fixed", fromSI: 3, toSI: 8 }, targetPoints: 800, xAxisId: "step" });
    expect(stepFixed).toMatchObject({ cursor: 12, includeTail: true });
    expect(stepFixed.fromRow).toBeUndefined();
    expect(stepFixed.toRow).toBeUndefined();
    expect(buildLiveChartsTableQuery({ columns: ["t", "mx"], cursor: 12, latestX: 10, range: { mode: "fixed", fromSI: 3, toSI: 8 }, targetPoints: 800, xAxisId: "t" })).toMatchObject({ fromT: 3, toT: 8, includeTail: false });
    expect(buildLiveChartsTableQuery({ columns: ["step", "mx"], cursor: 12, latestX: 10, range: { mode: "fullDecimated" }, targetPoints: 800, xAxisId: "step" })).toMatchObject({ includeTail: false, limit: 5_000, targetPoints: 800 });
  });

  it("keeps a tail-time window open for a row appended after the first fetch", () => {
    const range = { mode: "tailTime" as const, durationS: 1e-9 };
    const firstFetch = buildLiveChartsTableQuery({
      columns: ["t", "mx"],
      cursor: undefined,
      latestX: 4e-9,
      range,
      targetPoints: 800,
      xAxisId: "t",
    });
    const afterAppend = buildLiveChartsTableQuery({
      columns: ["t", "mx"],
      cursor: 4_000,
      latestX: 5e-9,
      range,
      targetPoints: 800,
      xAxisId: "t",
    });

    expect(firstFetch).toMatchObject({ cursor: undefined, includeTail: false, limit: 5_000 });
    expect(afterAppend).toMatchObject({ cursor: undefined, includeTail: false, limit: 5_000 });
    expect(firstFetch.fromT).toBeCloseTo(3e-9);
    expect(afterAppend.fromT).toBeCloseTo(4e-9);
    expect(firstFetch.toT).toBeUndefined();
    expect(afterAppend.toT).toBeUndefined();
  });

  it("fails closed instead of treating an arbitrary observable axis as row coordinates", () => {
    const query = buildLiveChartsTableQuery({
      columns: ["step", "mx"],
      cursor: 12,
      latestX: 10,
      range: { mode: "fixed", fromSI: 3, toSI: 8 },
      targetPoints: 800,
      xAxisId: "mx",
    });
    expect(query).toMatchObject({ cursor: 12, includeTail: true, limit: 5_000 });
    expect(query.fromRow).toBeUndefined();
    expect(query.toRow).toBeUndefined();
    expect(query.fromT).toBeUndefined();
    expect(query.toT).toBeUndefined();
  });

  it("resolves only published server-query axes and resets ranges after an axis fallback", () => {
    expect(resolveLiveChartXAxisId(["step", "t", "mx"], "mx")).toBe("step");
    expect(resolveLiveChartXAxisId(["t", "mx"], "removed-axis")).toBe("t");
    expect(resolveLiveChartXAxisId(["mx"], "removed-axis")).toBe("mx");

    expect(resolveLiveChartAxisAndRange(["step", "t", "mx"], "mx", { mode: "fixed", fromSI: 3, toSI: 8 })).toEqual({
      axisChanged: true,
      range: { mode: "follow" },
      xAxisId: "step",
    });
    expect(resolveLiveChartAxisAndRange(["step", "t", "mx"], "removed-axis", { mode: "tailTime", durationS: 1e-9 })).toEqual({
      axisChanged: true,
      range: { mode: "follow" },
      xAxisId: "step",
    });
    expect(resolveLiveChartAxisAndRange(["t", "mx"], "mx", { mode: "fixed", fromSI: 3, toSI: 8 })).toEqual({
      axisChanged: true,
      range: { mode: "follow" },
      xAxisId: "t",
    });
    expect(resolveLiveChartAxisAndRange(["t", "mx"], "mx", { mode: "tailTime", durationS: 1e-9 })).toEqual({
      axisChanged: true,
      range: { mode: "follow" },
      xAxisId: "t",
    });
    expect(resolveLiveChartAxisAndRange(["t", "mx"], "time", { mode: "fixed", fromSI: 3, toSI: 8 })).toEqual({
      axisChanged: true,
      range: { mode: "fixed", fromSI: 3, toSI: 8 },
      xAxisId: "t",
    });
    expect(resolveLiveChartAxisAndRange(["mx"], "removed-axis", { mode: "tailRows", rows: 120 })).toEqual({
      axisChanged: true,
      range: { mode: "tailRows", rows: 120 },
      xAxisId: "mx",
    });
    expect(resolveLiveChartAxisAndRange(["mx"], "removed-axis", { mode: "fullDecimated" })).toEqual({
      axisChanged: true,
      range: { mode: "fullDecimated" },
      xAxisId: "mx",
    });
    expect(normalizeLiveChartRangeForXAxis({ mode: "tailTime", durationS: 1e-9 }, "step")).toEqual({ mode: "follow" });
    expect(normalizeLiveChartRangeForXAxis({ mode: "fixed", fromSI: 3, toSI: 8 }, "step")).toEqual({ mode: "follow" });
    expect(normalizeLiveChartRangeForXAxis({ mode: "fixed", fromSI: 3, toSI: 8 }, "mx")).toEqual({ mode: "follow" });
    expect(normalizeLiveChartRangeForXAxis({ mode: "tailRows", rows: 120 }, "mx")).toEqual({ mode: "tailRows", rows: 120 });
  });
});

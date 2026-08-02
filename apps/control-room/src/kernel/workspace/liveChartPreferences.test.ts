import { describe, expect, it } from "vitest";

import {
  createDefaultLiveChartPreferences,
  LIVE_CHART_PREFERENCES_STORAGE_KEY,
  MAX_LIVE_CHART_DESCRIPTORS,
  parseLiveChartPreferences,
  serializeLiveChartPreferences,
} from "./liveChartPreferences";

const descriptor = {
  displayUnits: { mx: "" },
  liveMode: "paused" as const,
  range: { mode: "tailRows" as const, rows: 120 },
  selectedSeriesIds: ["mx"],
  targetPoints: 1600 as const,
  xAxisId: "time",
};

const validPreferences = {
  descriptors: { magnetization: descriptor },
  schemaVersion: 1,
};

describe("Live Chart preferences", () => {
  it("creates normalized magnetization defaults once", () => {
    expect(createDefaultLiveChartPreferences().descriptors.magnetization).toMatchObject({
      xAxisId: "step",
      selectedSeriesIds: ["mx", "my", "mz"],
      range: { mode: "follow" },
      liveMode: "following",
      targetPoints: 800,
    });
  });

  it("does not repopulate an explicitly empty selection", () => {
    const parsed = parseLiveChartPreferences({
      ...validPreferences,
      descriptors: { magnetization: { ...descriptor, selectedSeriesIds: [] } },
    });

    expect(parsed.descriptors.magnetization?.selectedSeriesIds).toEqual([]);
  });

  it("bounds descriptors and selected series while keeping valid preferences", () => {
    const descriptors = Object.fromEntries(
      Array.from({ length: MAX_LIVE_CHART_DESCRIPTORS + 4 }, (_, index) => [
        `descriptor-${index}`,
        { ...descriptor, selectedSeriesIds: Array.from({ length: 120 }, (_, series) => `m${series}`) },
      ]),
    );
    const parsed = parseLiveChartPreferences({ schemaVersion: 1, descriptors });

    expect(Object.keys(parsed.descriptors)).toHaveLength(MAX_LIVE_CHART_DESCRIPTORS);
    expect(parsed.descriptors["descriptor-0"]?.selectedSeriesIds).toHaveLength(100);
  });

  it("resets invalid target points and non-finite fixed ranges to defaults", () => {
    const parsed = parseLiveChartPreferences({
      ...validPreferences,
      descriptors: {
        magnetization: {
          ...descriptor,
          range: { mode: "fixed", fromSI: Number.NaN, toSI: Infinity },
          targetPoints: 999,
        },
      },
    });

    expect(parsed.descriptors.magnetization?.range).toEqual({ mode: "follow" });
    expect(parsed.descriptors.magnetization?.targetPoints).toBe(800);
  });

  it("rejects server payloads and renderer objects", () => {
    for (const invalid of [
      { ...validPreferences, descriptors: { magnetization: { ...descriptor, samples: [1, 2] } } },
      { ...validPreferences, descriptors: { magnetization: { ...descriptor, option: { title: "chart" } } } },
      { ...validPreferences, descriptors: { magnetization: { ...descriptor, values: new Float64Array([1]) } } },
    ]) {
      expect(parseLiveChartPreferences(invalid)).toEqual(createDefaultLiveChartPreferences());
    }
  });

  it("serializes only normalized preference fields", () => {
    const serialized = serializeLiveChartPreferences(validPreferences);

    expect(LIVE_CHART_PREFERENCES_STORAGE_KEY).toBe("fm:live-chart-preferences:v1");
    expect(JSON.parse(serialized)).toEqual(parseLiveChartPreferences(validPreferences));
  });
});

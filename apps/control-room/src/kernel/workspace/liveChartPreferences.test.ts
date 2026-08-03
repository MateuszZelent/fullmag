import { describe, expect, it, vi } from "vitest";

import {
  createDefaultLiveChartPreferences,
  LIVE_CHART_PREFERENCES_STORAGE_KEY,
  MAX_LEGACY_STORED_BYTES,
  MAX_LIVE_CHART_DESCRIPTORS,
  MAX_NEW_STORED_BYTES,
  migrateLegacyLiveChartPreferences,
  parseLiveChartPreferences,
  parseStoredLiveChartPreferences,
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
    expect(serialized).not.toBeNull();
    expect(JSON.parse(serialized!)).toEqual(parseLiveChartPreferences(validPreferences));
  });

  it("uses the compact Analysis-compatible storage budget", () => {
    expect(MAX_NEW_STORED_BYTES).toBe(256 * 1024);
    expect(MAX_LEGACY_STORED_BYTES).toBe(MAX_NEW_STORED_BYTES);
  });

  it("rejects a raw value one byte over budget before JSON parsing", () => {
    expect(parseStoredLiveChartPreferences(" ".repeat(MAX_NEW_STORED_BYTES + 1))).toEqual(
      createDefaultLiveChartPreferences(),
    );
  });

  it("rejects huge new and legacy values before allocating encoded copies", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const oversized = " ".repeat(MAX_NEW_STORED_BYTES * 16);

    try {
      expect(parseStoredLiveChartPreferences(oversized)).toEqual(createDefaultLiveChartPreferences());
      expect(migrateLegacyLiveChartPreferences(oversized)).toEqual(createDefaultLiveChartPreferences());
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("uses exact UTF-8 byte accounting for Unicode inside the code-unit budget", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const serialized = JSON.stringify("€".repeat(100_000));

    try {
      expect(serialized.length).toBeLessThanOrEqual(MAX_NEW_STORED_BYTES);
      expect(parseStoredLiveChartPreferences(serialized)).toEqual(createDefaultLiveChartPreferences());
      expect(encode).toHaveBeenCalledOnce();
    } finally {
      encode.mockRestore();
    }
  });

  it("rejects a normalized schema that cannot be persisted compactly", () => {
    const preferences = {
      descriptors: Object.fromEntries(Array.from({ length: MAX_LIVE_CHART_DESCRIPTORS }, (_, descriptorIndex) => {
        const suffix = String(descriptorIndex).padStart(3, "0");
        const descriptorId = `descriptor-${suffix}`.padEnd(160, "d");
        const selectedSeriesIds = Array.from({ length: 100 }, (_, seriesIndex) =>
          `series-${String(seriesIndex).padStart(3, "0")}`.padEnd(160, "s"),
        );
        const displayUnits = Object.fromEntries(Array.from({ length: 40 }, (_, unitIndex) => [
          `unit-${String(unitIndex).padStart(3, "0")}`.padEnd(160, "u"),
          "T".padEnd(24, "t"),
        ]));
        return [descriptorId, {
          displayUnits,
          liveMode: "paused",
          range: { mode: "fixed", fromSI: -1.7976931348623157e308, toSI: 1.7976931348623157e308 },
          selectedSeriesIds,
          targetPoints: 5000,
          xAxisId: "x".padEnd(160, "x"),
        }];
      })),
      schemaVersion: 1,
    };

    const serialized = serializeLiveChartPreferences(preferences);

    expect(serialized).toBeNull();
  });

  it("rejects oversized selected-id arrays before visiting their items", () => {
    let indexedReads = 0;
    const selectedSeriesIds = new Proxy(Array.from({ length: 10_000 }, () => "mx"), {
      get(target, property, receiver) {
        if (/^\d+$/.test(String(property))) indexedReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(parseLiveChartPreferences({
      ...validPreferences,
      descriptors: { magnetization: { ...descriptor, selectedSeriesIds } },
    })).toEqual(createDefaultLiveChartPreferences());
    expect(indexedReads).toBe(0);
  });

  it("stops descriptor validation at the configured budget", () => {
    let descriptorReads = 0;
    const descriptors = new Proxy({}, {
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
      get: () => {
        descriptorReads += 1;
        return descriptor;
      },
      ownKeys: () => Array.from({ length: 10_000 }, (_, index) => `descriptor-${index}`),
    });

    expect(Object.keys(parseLiveChartPreferences({ schemaVersion: 1, descriptors }).descriptors)).toHaveLength(
      MAX_LIVE_CHART_DESCRIPTORS,
    );
    expect(descriptorReads).toBeLessThanOrEqual(MAX_LIVE_CHART_DESCRIPTORS + 1);
  });
});

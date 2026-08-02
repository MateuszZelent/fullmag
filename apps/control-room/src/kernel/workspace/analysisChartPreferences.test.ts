import { describe, expect, it } from "vitest";

import {
  ANALYSIS_CHART_PREFERENCES_STORAGE_KEY,
  chartRangePreferenceFromWorkspace,
  clampRangePreference,
  clampTargetPoints,
  defaultAnalysisChartPreferences,
  defaultDescriptorPreferences,
  getOrCreateDescriptorPreferences,
  MAX_DESCRIPTORS,
  readAnalysisChartPreferencesFromStorage,
  validateAnalysisChartPreferences,
  validateDescriptorPreferences,
  writeAnalysisChartPreferencesToStorage,
} from "./analysisChartPreferences";

describe("clampTargetPoints", () => {
  it("accepts valid bucket values", () => {
    expect(clampTargetPoints(160)).toBe(160);
    expect(clampTargetPoints(1600)).toBe(1600);
    expect(clampTargetPoints(5000)).toBe(5000);
  });

  it("snaps invalid values to nearest bucket", () => {
    expect(clampTargetPoints(300)).toBe(400);
    expect(clampTargetPoints(1500)).toBe(1600);
    // 0 and negatives are not valid positive counts — fall back to default
    expect(clampTargetPoints(0)).toBe(1600);
    expect(clampTargetPoints(-1)).toBe(1600);
  });

  it("returns default for non-numeric values", () => {
    expect(clampTargetPoints("abc")).toBe(1600);
    expect(clampTargetPoints(null)).toBe(1600);
    expect(clampTargetPoints(undefined)).toBe(1600);
  });
});

describe("clampRangePreference", () => {
  it("maps Inspector-owned fixed ranges into persisted SI preferences", () => {
    expect(
      chartRangePreferenceFromWorkspace(
        { mode: "fixed" },
        { fromValue: 2e-9, toValue: 5e-9 },
      ),
    ).toEqual({ fromSI: 2e-9, mode: "fixed", toSI: 5e-9 });
    expect(chartRangePreferenceFromWorkspace({ mode: "fixed" }, null)).toEqual({ mode: "follow" });
  });

  it("accepts all valid modes", () => {
    expect(clampRangePreference({ mode: "follow" })).toEqual({ mode: "follow" });
    expect(clampRangePreference({ mode: "fullDecimated" })).toEqual({ mode: "fullDecimated" });
    expect(clampRangePreference({ mode: "tailRows", rows: 100 })).toEqual({ mode: "tailRows", rows: 100 });
    expect(clampRangePreference({ mode: "tailTime", durationS: 1e-9 })).toEqual({ mode: "tailTime", durationS: 1e-9 });
    expect(clampRangePreference({ mode: "fixed", fromSI: 0, toSI: 10 })).toEqual({ mode: "fixed", fromSI: 0, toSI: 10 });
  });

  it("clamps tailRows to 10..5000", () => {
    expect(clampRangePreference({ mode: "tailRows", rows: 3 })).toEqual({ mode: "tailRows", rows: 10 });
    expect(clampRangePreference({ mode: "tailRows", rows: 9999 })).toEqual({ mode: "tailRows", rows: 5000 });
  });

  it("falls back to follow for invalid fixed range (from >= to)", () => {
    expect(clampRangePreference({ mode: "fixed", fromSI: 10, toSI: 5 })).toEqual({ mode: "follow" });
    expect(clampRangePreference({ mode: "fixed", fromSI: 5, toSI: 5 })).toEqual({ mode: "follow" });
  });

  it("falls back to follow for unknown mode", () => {
    expect(clampRangePreference({ mode: "unknown" })).toEqual({ mode: "follow" });
    expect(clampRangePreference(null)).toEqual({ mode: "follow" });
    expect(clampRangePreference("follow")).toEqual({ mode: "follow" });
  });
});

describe("validateDescriptorPreferences", () => {
  it("returns defaults for null/invalid input", () => {
    expect(validateDescriptorPreferences(null)).toEqual(defaultDescriptorPreferences());
    expect(validateDescriptorPreferences("bad")).toEqual(defaultDescriptorPreferences());
  });

  it("validates and clamps all fields", () => {
    const result = validateDescriptorPreferences({
      displayUnits: { energy: "eV" },
      selectedSeriesIds: ["data.table:default:step:mx", 42, "data.table:default:step:my"], // 42 should be stripped
      liveMode: "paused",
      range: { mode: "tailRows", rows: 200 },
      targetPoints: 3200,
      xAxisId: "t",
    });
    expect(result.selectedSeriesIds).toEqual([
      "data.table:default:step:mx",
      "data.table:default:step:my",
    ]);
    expect(result.liveMode).toBe("paused");
    expect(result.range).toEqual({ mode: "tailRows", rows: 200 });
    expect(result.targetPoints).toBe(3200);
  });

  it("resets invalid liveMode to following", () => {
    const result = validateDescriptorPreferences({ liveMode: "streaming" });
    expect(result.liveMode).toBe("following");
  });

  it("limits selectedSeriesIds to 100 entries", () => {
    const many = Array.from({ length: 30 }, (_, i) => `col${i}`);
    const result = validateDescriptorPreferences({ selectedSeriesIds: many });
    expect(result.selectedSeriesIds.length).toBe(30);
  });

  it("migrates legacy V1 yAxisIds per descriptor and preserves explicit empty selections", () => {
    expect(validateDescriptorPreferences({ xAxisId: "t", yAxisIds: ["mx"] }, "analysis:data-table:default").selectedSeriesIds).toEqual(["data.table:default:t:mx"]);
    expect(validateDescriptorPreferences({ yAxisIds: ["total"] }, "analysis:solver-energy-history").selectedSeriesIds).toEqual(["simulation.solver.energies:total"]);
    expect(validateDescriptorPreferences({ yAxisIds: ["response:mx"] }, "analysis:frequency-domain").selectedSeriesIds).toEqual(["analysis.frequency-domain:response:mx"]);
    expect(validateDescriptorPreferences({ selectedSeriesIds: [] }, "analysis:solver-energy-history").selectedSeriesIds).toEqual([]);
  });

  it("replaces the historical shared table default for energy and frequency without weakening normalization", () => {
    const legacy = { yAxisIds: ["mx", "my", "mz", "e_total"] };
    expect(validateDescriptorPreferences(legacy, "analysis:solver-energy-history").selectedSeriesIds).toEqual(defaultDescriptorPreferences("analysis:solver-energy-history").selectedSeriesIds);
    expect(validateDescriptorPreferences(legacy, "analysis:frequency-domain").selectedSeriesIds).toEqual([]);
    const corrupted = Array.from({ length: 130 }, (_, index) => index % 2 ? "x".repeat(200) : "total");
    const migrated = validateDescriptorPreferences({ yAxisIds: corrupted }, "analysis:solver-energy-history").selectedSeriesIds;
    expect(migrated).toHaveLength(2);
    expect(new Set(migrated).size).toBe(migrated.length);
    expect(migrated.every((id) => id.length <= 160)).toBe(true);
  });
});

describe("validateAnalysisChartPreferences", () => {
  it("returns defaults for null/invalid/wrong schema version", () => {
    expect(validateAnalysisChartPreferences(null)).toEqual(defaultAnalysisChartPreferences());
    expect(validateAnalysisChartPreferences({ schemaVersion: 2 })).toEqual(defaultAnalysisChartPreferences());
  });

  it("validates nested descriptor preferences", () => {
    const result = validateAnalysisChartPreferences({
      schemaVersion: 1,
      activeSurface: "energy",
      descriptorPreferences: {
        "solver/energies": {
          targetPoints: 800,
          range: { mode: "tailRows", rows: 50 },
          liveMode: "following",
        },
      },
      _lruAccessAt: { "solver/energies": 1000 },
    });
    expect(result.activeSurface).toBe("energy");
    expect(result.descriptorPreferences["solver/energies"]?.targetPoints).toBe(800);
    expect(result.descriptorPreferences["solver/energies"]?.range).toEqual({ mode: "tailRows", rows: 50 });
  });

  it("enforces MAX_DESCRIPTORS by evicting oldest LRU entries", () => {
    const manyDescriptors: Record<string, object> = {};
    const lruAccessAt: Record<string, number> = {};
    for (let i = 0; i < MAX_DESCRIPTORS + 10; i++) {
      manyDescriptors[`desc-${i}`] = {};
      lruAccessAt[`desc-${i}`] = i; // higher = more recent
    }
    const result = validateAnalysisChartPreferences({
      schemaVersion: 1,
      activeSurface: "overview",
      descriptorPreferences: manyDescriptors,
      _lruAccessAt: lruAccessAt,
    });
    expect(Object.keys(result.descriptorPreferences).length).toBe(MAX_DESCRIPTORS);
    // Oldest (desc-0 through desc-9) should be evicted
    expect(result.descriptorPreferences["desc-0"]).toBeUndefined();
    expect(result.descriptorPreferences[`desc-${MAX_DESCRIPTORS + 9}`]).toBeDefined();
  });
});

describe("readAnalysisChartPreferencesFromStorage", () => {
  it("returns defaults when localStorage is empty", () => {
    // localStorage is not available in node test env, reads safely
    const result = readAnalysisChartPreferencesFromStorage();
    expect(result.schemaVersion).toBe(1);
  });
});

describe("writeAnalysisChartPreferencesToStorage / readAnalysisChartPreferencesFromStorage", () => {
  it("round-trips preferences through localStorage", () => {
    const prefs = defaultAnalysisChartPreferences();
    const { prefs: updated, descriptor } = getOrCreateDescriptorPreferences(prefs, "test-desc");
    const withModified = {
      ...updated,
      descriptorPreferences: {
        ...updated.descriptorPreferences,
        "test-desc": { ...descriptor, targetPoints: 800 as const, liveMode: "paused" as const },
      },
    };
    const store: Record<string, string> = {};
    const fakeLocalStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      Object.defineProperty(globalThis, "localStorage", { value: fakeLocalStorage, configurable: true });
      writeAnalysisChartPreferencesToStorage(withModified);
      expect(store[ANALYSIS_CHART_PREFERENCES_STORAGE_KEY]).toBeDefined();
      const loaded = readAnalysisChartPreferencesFromStorage();
      expect(loaded.descriptorPreferences["test-desc"]?.targetPoints).toBe(800);
      expect(loaded.descriptorPreferences["test-desc"]?.liveMode).toBe("paused");
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe("getOrCreateDescriptorPreferences", () => {
  it("uses energy defaults for a new energy descriptor instead of table IDs", () => {
    const { descriptor } = getOrCreateDescriptorPreferences(
      defaultAnalysisChartPreferences(),
      "analysis:solver-energy-history",
    );

    expect(descriptor.selectedSeriesIds).toEqual([
      "simulation.solver.energies:exchange",
      "simulation.solver.energies:demag",
      "simulation.solver.energies:zeeman",
      "simulation.solver.energies:anisotropy",
      "simulation.solver.energies:dmi",
      "simulation.solver.energies:total",
    ]);
  });

  it("creates new descriptor with defaults when not present", () => {
    const prefs = defaultAnalysisChartPreferences();
    const { descriptor } = getOrCreateDescriptorPreferences(prefs, "new-key");
    expect(descriptor).toEqual(defaultDescriptorPreferences());
  });

  it("returns existing descriptor when already present", () => {
    const prefs = defaultAnalysisChartPreferences();
    const { prefs: prefs1, descriptor: d1 } = getOrCreateDescriptorPreferences(prefs, "key-a");
    const modified = {
      ...prefs1,
      descriptorPreferences: {
        "key-a": { ...d1, targetPoints: 3200 as const },
      },
    };
    const { descriptor: d2 } = getOrCreateDescriptorPreferences(modified, "key-a");
    expect(d2.targetPoints).toBe(3200);
  });
});

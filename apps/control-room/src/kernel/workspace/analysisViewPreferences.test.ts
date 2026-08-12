import { describe, expect, it } from "vitest";

import {
  ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY,
  analysisDescriptorId,
  createDefaultAnalysisViewPreferences,
  parseAnalysisViewPreferences,
  parseStoredAnalysisViewPreferences,
  serializeAnalysisViewPreferences,
} from "./analysisViewPreferences";

describe("analysis view preferences", () => {
  it("keeps the five physics-first analysis surfaces and migrates old IDs", () => {
    const preferences = createDefaultAnalysisViewPreferences();

    expect(ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY).toBe("fm:analysis-view-preferences:v2");
    expect(preferences.activeSurface).toBe("dynamics");
    expect(preferences.selectedDatasetRef).toBeNull();

    for (const activeSurface of [
      "dynamics", "resonance-fmr", "dispersion", "hysteresis", "comparison",
    ]) {
      expect(parseAnalysisViewPreferences({ schemaVersion: 2, activeSurface, selectedDatasetRef: "table:run-7:stage-2:table-4", descriptorPreferences: {} }).activeSurface).toBe(activeSurface);
    }
    expect(parseAnalysisViewPreferences({ schemaVersion: 2, activeSurface: "frequency-response", selectedDatasetRef: null, descriptorPreferences: {} }).activeSurface).toBe("resonance-fmr");
    expect(parseAnalysisViewPreferences({ schemaVersion: 2, activeSurface: "eigenmodes", selectedDatasetRef: null, descriptorPreferences: {} }).activeSurface).toBe("resonance-fmr");
    expect(parseAnalysisViewPreferences({ schemaVersion: 2, activeSurface: "spectrum", selectedDatasetRef: null, descriptorPreferences: {} }).activeSurface).toBe("dynamics");
  });

  it("bounds complete descriptor preferences and drops malformed descriptors", () => {
    const preferences = parseAnalysisViewPreferences({
      schemaVersion: 2,
      activeSurface: "dynamics",
      selectedDatasetRef: "x".repeat(300),
      descriptorPreferences: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
        `descriptor-${index}`,
        { selectedSeriesIds: Array.from({ length: 140 }, (_, series) => `series-${series}`), displayUnits: Object.fromEntries(Array.from({ length: 60 }, (_, unit) => [`unit-${unit}`, "A/m"])), range: null },
      ])),
    });

    expect(preferences.selectedDatasetRef).toBeNull();
    expect(Object.keys(preferences.descriptorPreferences)).toHaveLength(50);
    expect(preferences.descriptorPreferences["descriptor-0"]?.selectedSeriesIds).toHaveLength(100);
    expect(Object.keys(preferences.descriptorPreferences["descriptor-0"]?.displayUnits ?? {})).toHaveLength(40);
    expect(preferences.descriptorPreferences["descriptor-0"]?.range).toBeNull();

    expect(parseAnalysisViewPreferences({
      schemaVersion: 2,
      activeSurface: "dynamics",
      selectedDatasetRef: null,
      descriptorPreferences: { broken: { selectedSeriesIds: [], displayUnits: {}, range: { fromSI: 4, toSI: 3 } } },
    }).descriptorPreferences).toEqual({});
  });

  it("persists only bounded semantic comparison keys", () => {
    const preferences = parseAnalysisViewPreferences({
      schemaVersion: 2,
      activeSurface: "comparison",
      selectedDatasetRef: "table-a",
      descriptorPreferences: {
        "comparison:table-a:table-b": {
          comparisonSelectedSeriesKeys: ["mx|1", "mx|1", "x".repeat(1100)],
          displayUnits: {},
          range: null,
        },
      },
    });
    expect(preferences.descriptorPreferences["comparison:table-a:table-b"]?.selectedSeriesIds).toEqual(["mx|1"]);
  });

  it("keeps complete descriptors and does not turn a partial patch into an explicit empty selection", () => {
    const partial = parseAnalysisViewPreferences({
      schemaVersion: 2,
      activeSurface: "frequency-response",
      selectedDatasetRef: null,
      descriptorPreferences: { "artifact:frequency-response:v-response": { displayUnits: { amplitude: "nJ" } } },
    });
    expect(partial.descriptorPreferences).toEqual({});

    const explicitEmpty = parseStoredAnalysisViewPreferences(serializeAnalysisViewPreferences({
      schemaVersion: 2,
      activeSurface: "frequency-response",
      selectedDatasetRef: null,
      descriptorPreferences: { "artifact:frequency-response:v-response": { displayUnits: { amplitude: "nJ" }, range: null, selectedSeriesIds: [] } },
    }));
    expect(explicitEmpty.descriptorPreferences["artifact:frequency-response:v-response"]?.selectedSeriesIds).toEqual([]);

    expect(parseAnalysisViewPreferences({
      schemaVersion: 2,
      activeSurface: "frequency-response",
      selectedDatasetRef: null,
      descriptorPreferences: {
        "artifact:frequency-response:v-response": {
          displayUnits: {},
          range: null,
          selectedSeriesIds: ["x".repeat(1025)],
        },
      },
    }).descriptorPreferences).toEqual({});
  });

  it("creates collision-safe bounded descriptor identities for null, colon refs, and max-length components", () => {
    expect(analysisDescriptorId({ kind: "dataset", surface: "dynamics", datasetRef: null })).not.toBe(
      analysisDescriptorId({ kind: "dataset", surface: "dynamics", datasetRef: "none" }),
    );
    expect(analysisDescriptorId({ kind: "comparison", primaryDatasetRef: "a:b", secondaryDatasetRef: "c" })).not.toBe(
      analysisDescriptorId({ kind: "comparison", primaryDatasetRef: "a", secondaryDatasetRef: "b:c" }),
    );
    expect(analysisDescriptorId({ kind: "dataset", surface: "dynamics", datasetRef: "x".repeat(160) }).length).toBeLessThanOrEqual(512);
    expect(() => analysisDescriptorId({ kind: "dataset", surface: "dynamics", datasetRef: "\ud800" })).not.toThrow();
  });

  it("round-trips legal derived table series IDs longer than a raw ref", () => {
    const table = "t".repeat(160);
    const seriesId = `data.table:${table}:${"x".repeat(160)}:${"y".repeat(160)}`;
    const parsed = parseStoredAnalysisViewPreferences(serializeAnalysisViewPreferences({
      schemaVersion: 2,
      activeSurface: "dynamics",
      selectedDatasetRef: table,
      descriptorPreferences: { [analysisDescriptorId({ kind: "dataset", surface: "dynamics", datasetRef: table })]: { displayUnits: {}, range: null, selectedSeriesIds: [seriesId] } },
    }));
    expect(Object.values(parsed.descriptorPreferences)[0]?.selectedSeriesIds).toEqual([seriesId]);
  });
});

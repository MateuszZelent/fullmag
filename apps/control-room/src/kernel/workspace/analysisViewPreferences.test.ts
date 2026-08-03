import { describe, expect, it } from "vitest";

import {
  ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY,
  createDefaultAnalysisViewPreferences,
  parseAnalysisViewPreferences,
} from "./analysisViewPreferences";

describe("analysis view preferences", () => {
  it("keeps the seven declared analysis surfaces and an explicit dataset reference", () => {
    const preferences = createDefaultAnalysisViewPreferences();

    expect(ANALYSIS_VIEW_PREFERENCES_STORAGE_KEY).toBe("fm:analysis-view-preferences:v2");
    expect(preferences.activeSurface).toBe("dynamics");
    expect(preferences.selectedDatasetRef).toBeNull();

    for (const activeSurface of [
      "dynamics", "spectrum", "frequency-response", "eigenmodes", "dispersion", "hysteresis", "comparison",
    ]) {
      expect(parseAnalysisViewPreferences({ schemaVersion: 2, activeSurface, selectedDatasetRef: "table:run-7:stage-2:table-4", descriptorPreferences: {} }).activeSurface).toBe(activeSurface);
    }
  });

  it("bounds descriptor preferences and rejects invalid ranges", () => {
    const preferences = parseAnalysisViewPreferences({
      schemaVersion: 2,
      activeSurface: "dynamics",
      selectedDatasetRef: "x".repeat(300),
      descriptorPreferences: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
        `descriptor-${index}`,
        { selectedSeriesIds: Array.from({ length: 140 }, (_, series) => `series-${series}`), displayUnits: Object.fromEntries(Array.from({ length: 60 }, (_, unit) => [`unit-${unit}`, "A/m"])), range: { fromSI: 4, toSI: 3 } },
      ])),
    });

    expect(preferences.selectedDatasetRef).toBeNull();
    expect(Object.keys(preferences.descriptorPreferences)).toHaveLength(50);
    expect(preferences.descriptorPreferences["descriptor-0"]?.selectedSeriesIds).toHaveLength(100);
    expect(Object.keys(preferences.descriptorPreferences["descriptor-0"]?.displayUnits ?? {})).toHaveLength(40);
    expect(preferences.descriptorPreferences["descriptor-0"]?.range).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  defaultAnalysisChartPreferences,
  readAnalysisChartPreferencesFromStorage,
  writeAnalysisChartPreferencesToStorage,
} from "./analysisChartPreferences";

describe("useAnalysisChartPreferencesHydration & storage", () => {
  it("defaultAnalysisChartPreferences returns initial schema v1 preferences", () => {
    const prefs = defaultAnalysisChartPreferences();
    expect(prefs.schemaVersion).toBe(1);
    expect(prefs.activeSurface).toBe("overview");
    expect(prefs.descriptorPreferences).toBeDefined();
  });

  it("writes and reads preferences to storage when window/localStorage exists", () => {
    const storageMap = new Map<string, string>();
    const mockStorage = {
      length: 0,
      clear: () => storageMap.clear(),
      key: (index: number) => Array.from(storageMap.keys())[index] ?? null,
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, val: string) => storageMap.set(key, val),
      removeItem: (key: string) => storageMap.delete(key),
    } as Storage;

    const originalWindow = globalThis.window;
    // @ts-expect-error mock window
    globalThis.window = {
      localStorage: mockStorage,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const prefs = defaultAnalysisChartPreferences();
    prefs.activeSurface = "energy";

    writeAnalysisChartPreferencesToStorage(prefs);
    const read = readAnalysisChartPreferencesFromStorage();
    expect(read.activeSurface).toBe("energy");

    globalThis.window = originalWindow;
  });
});

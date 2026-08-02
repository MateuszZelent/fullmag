import { describe, expect, it } from "vitest";

import {
  LIVE_CHART_PREFERENCES_STORAGE_KEY,
  createDefaultLiveChartPreferences,
  resetLiveChartPreferencesStoreForTests,
  liveChartPreferencesStore,
} from "./liveChartPreferences";

describe("useLiveChartPreferencesHydration", () => {
  it("keeps the server and first client snapshots identical", () => {
    resetLiveChartPreferencesStoreForTests();

    expect(liveChartPreferencesStore.getServerSnapshot()).toEqual(
      liveChartPreferencesStore.getSnapshot(),
    );
  });

  it("marks hydration complete even when browser storage is unavailable", () => {
    resetLiveChartPreferencesStoreForTests();
    let notifications = 0;
    const unsubscribe = liveChartPreferencesStore.subscribe(() => {
      notifications += 1;
    });

    expect(liveChartPreferencesStore.isHydrated()).toBe(true);
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("migrates unambiguous legacy live fields once without writing the old key", () => {
    const values = new Map<string, string>([
      ["fm:analysis-chart-preferences:v1", JSON.stringify({
        schemaVersion: 1,
        activeSurface: "overview",
        descriptorPreferences: {
          "analysis:data-table:default": {
            displayUnits: { mx: "" },
            liveMode: "paused",
            range: { mode: "tailRows", rows: 24 },
            selectedSeriesIds: ["data.table:default:step:mx", "data.table:default:step:mz"],
            targetPoints: 1600,
            xAxisId: "time",
          },
        },
        _lruAccessAt: {},
      })],
    ]);
    const writes: string[] = [];
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push(key);
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    } as unknown as Storage;

    resetLiveChartPreferencesStoreForTests(storage);
    liveChartPreferencesStore.hydrate();

    expect(liveChartPreferencesStore.getSnapshot().descriptors.magnetization).toMatchObject({
      xAxisId: "time",
      selectedSeriesIds: ["mx", "mz"],
      liveMode: "paused",
      targetPoints: 1600,
    });
    expect(writes).toEqual([LIVE_CHART_PREFERENCES_STORAGE_KEY]);
    expect(values.get("fm:analysis-chart-preferences:v1")).toBeDefined();
  });

  it("resets only the new preference key", () => {
    const values = new Map<string, string>([
      [LIVE_CHART_PREFERENCES_STORAGE_KEY, JSON.stringify(createDefaultLiveChartPreferences())],
      ["fm:analysis-chart-preferences:v1", "legacy"],
    ]);
    const removed: string[] = [];
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => {
        removed.push(key);
        values.delete(key);
      },
    } as unknown as Storage;

    resetLiveChartPreferencesStoreForTests(storage);
    liveChartPreferencesStore.reset();

    expect(removed).toEqual([LIVE_CHART_PREFERENCES_STORAGE_KEY]);
    expect(values.get("fm:analysis-chart-preferences:v1")).toBe("legacy");
  });
});

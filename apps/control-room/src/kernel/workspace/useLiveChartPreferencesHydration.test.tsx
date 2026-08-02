import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_CHART_PREFERENCES_STORAGE_KEY,
  createDefaultLiveChartPreferences,
  resetLiveChartPreferencesStoreForTests,
  liveChartPreferencesStore,
} from "./liveChartPreferences";

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
});

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

  it("keeps migrated preferences in memory when persistence throws", () => {
    const legacy = JSON.stringify({
      schemaVersion: 1,
      descriptorPreferences: {
        "analysis:data-table:default": {
          selectedSeriesIds: ["data.table:default:step:mz"],
          xAxisId: "time",
        },
      },
    });
    const values = new Map<string, string>([["fm:analysis-chart-preferences:v1", legacy]]);
    const readKeys: string[] = [];
    const writeKeys: string[] = [];
    const storage = {
      getItem: (key: string) => {
        readKeys.push(key);
        return values.get(key) ?? null;
      },
      removeItem: () => undefined,
      setItem: (key: string) => {
        writeKeys.push(key);
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    let notifications = 0;

    resetLiveChartPreferencesStoreForTests(storage);
    const unsubscribe = liveChartPreferencesStore.subscribe(() => {
      notifications += 1;
    });

    expect(liveChartPreferencesStore.getSnapshot().descriptors.magnetization).toMatchObject({
      selectedSeriesIds: ["mz"],
      xAxisId: "time",
    });
    expect(readKeys).toEqual([
      LIVE_CHART_PREFERENCES_STORAGE_KEY,
      "fm:analysis-chart-preferences:v1",
    ]);
    expect(writeKeys).toEqual([LIVE_CHART_PREFERENCES_STORAGE_KEY]);
    expect(values.get("fm:analysis-chart-preferences:v1")).toBe(legacy);
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("treats a throwing localStorage getter as unavailable for hydrate, writes, and reset", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    let getterCalls = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          getterCalls += 1;
          throw new Error("SecurityError");
        },
      },
    });
    try {
      resetLiveChartPreferencesStoreForTests(undefined);

      expect(() => liveChartPreferencesStore.subscribe(() => undefined)).not.toThrow();
      expect(() => liveChartPreferencesStore.updateDescriptor("magnetization", () => ({ liveMode: "paused" }))).not.toThrow();
      expect(() => liveChartPreferencesStore.reset()).not.toThrow();
      expect(getterCalls).toBeGreaterThan(0);
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("uses one external-store subscription for preferences and hydration", async () => {
    const useSyncExternalStore = vi.fn((_: unknown, getSnapshot: () => unknown) => getSnapshot());
    vi.doMock("react", () => ({
      useCallback: <T,>(callback: T) => callback,
      useSyncExternalStore,
    }));
    const { useLiveChartPreferencesHydration } = await import("./useLiveChartPreferencesHydration");

    useLiveChartPreferencesHydration("magnetization");

    expect(useSyncExternalStore).toHaveBeenCalledTimes(1);
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

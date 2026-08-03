import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_CHART_PREFERENCES_STORAGE_KEY,
  MAX_NEW_STORED_BYTES,
  createDefaultLiveChartPreferences,
  resetLiveChartPreferencesStoreForTests,
  liveChartPreferencesStore,
} from "./liveChartPreferences";

function escapedText(prefix: string, maximumLength: number): string {
  const escapedToken = `\"${String.fromCharCode(0)}${String.fromCharCode(0xd800)}`;
  return `${prefix}${escapedToken.repeat(Math.ceil(maximumLength / escapedToken.length))}`.slice(0, maximumLength);
}

function escapedDescriptorPatch(index: number) {
  return {
    displayUnits: {},
    liveMode: "paused" as const,
    range: { mode: "tailRows" as const, rows: 24 },
    selectedSeriesIds: Array.from({ length: 100 }, (_, seriesIndex) => escapedText(`${index}-${seriesIndex}:`, 160)),
    targetPoints: 1600 as const,
    xAxisId: escapedText(`time-${index}:`, 160),
  };
}

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

  it("round-trips compact escaped preferences through browser storage", () => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => {
        writes.push(key);
        values.set(key, value);
      },
    } as unknown as Storage;

    resetLiveChartPreferencesStoreForTests(storage);
    const unsubscribe = liveChartPreferencesStore.subscribe(() => undefined);
    writes.length = 0;
    for (let index = 0; index < 3; index += 1) {
      liveChartPreferencesStore.updateDescriptor(escapedText(`descriptor-${index}:`, 160), () => escapedDescriptorPatch(index));
    }
    const persisted = values.get(LIVE_CHART_PREFERENCES_STORAGE_KEY);
    const expected = liveChartPreferencesStore.getSnapshot();

    expect(persisted).toBeDefined();
    expect(new TextEncoder().encode(persisted!).byteLength).toBeLessThanOrEqual(MAX_NEW_STORED_BYTES);
    expect(persisted).toContain('\\"');
    expect(persisted).toContain("\\u0000");
    expect(persisted).toContain("\\ud800");

    resetLiveChartPreferencesStoreForTests(storage);
    const rehydratedUnsubscribe = liveChartPreferencesStore.subscribe(() => undefined);

    expect(liveChartPreferencesStore.getSnapshot()).toEqual(expected);
    unsubscribe();
    rehydratedUnsubscribe();
  });

  it("rejects an escaped update over budget without snapshot drift or a storage write", () => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => {
        writes.push(key);
        values.set(key, value);
      },
    } as unknown as Storage;

    resetLiveChartPreferencesStoreForTests(storage);
    const unsubscribe = liveChartPreferencesStore.subscribe(() => undefined);
    for (let index = 0; index < 3; index += 1) {
      liveChartPreferencesStore.updateDescriptor(escapedText(`descriptor-${index}:`, 160), () => escapedDescriptorPatch(index));
    }
    const snapshotBeforeRejectedUpdate = liveChartPreferencesStore.getSnapshot();
    writes.length = 0;

    liveChartPreferencesStore.updateDescriptor(escapedText("descriptor-over-budget:", 160), () => escapedDescriptorPatch(4));

    expect(liveChartPreferencesStore.getSnapshot()).toBe(snapshotBeforeRejectedUpdate);
    expect(writes).toEqual([]);
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

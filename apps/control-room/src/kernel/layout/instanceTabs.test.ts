import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INSTANCE_TAB_FRAME_NAME,
  INSTANCE_TABS_STORAGE_KEY,
  MAX_MOUNTED_FRAMES,
  instanceOrigin,
  instanceTabs,
  isEmbeddedInstanceTab,
} from "./instanceTabs";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe("instanceTabs", () => {
  beforeEach(() => instanceTabs.resetForTests());
  afterEach(() => vi.unstubAllGlobals());

  it("opens a tab once, brings it to the front and frames it", () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });

    instanceTabs.open(3206);
    instanceTabs.open(3210);
    instanceTabs.open(3206);

    expect(instanceTabs.getSnapshot()).toEqual({
      openPorts: [3206, 3210],
      activePort: 3206,
      framedPorts: [3210, 3206],
    });
    expect(storage.values.get(INSTANCE_TABS_STORAGE_KEY)).toBe("[3206,3210]");
  });

  it("returns to Home or this session without closing instance tabs", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    instanceTabs.open(3206);
    instanceTabs.activate(null);
    expect(instanceTabs.getSnapshot()).toMatchObject({ openPorts: [3206], activePort: null });
    instanceTabs.activate(3299);
    expect(instanceTabs.getSnapshot().activePort).toBeNull();
  });

  it("closing a tab drops its frame and leaves the front tab otherwise alone", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    instanceTabs.open(3206);
    instanceTabs.open(3210);
    instanceTabs.close(3206);
    expect(instanceTabs.getSnapshot()).toEqual({
      openPorts: [3210],
      activePort: 3210,
      framedPorts: [3210],
    });
    instanceTabs.close(3210);
    expect(instanceTabs.getSnapshot()).toEqual({ openPorts: [], activePort: null, framedPorts: [] });
  });

  it("restores open tabs without loading their frames, ignoring invalid entries", () => {
    vi.stubGlobal("window", {
      localStorage: memoryStorage({ [INSTANCE_TABS_STORAGE_KEY]: '[3206,"x",3206,0,70000,3210]' }),
    });
    expect(instanceTabs.getSnapshot()).toEqual({
      openPorts: [3206, 3210],
      activePort: null,
      framedPorts: [],
    });
  });

  it("keeps working when storage throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    instanceTabs.open(3206);
    expect(instanceTabs.getSnapshot().openPorts).toEqual([3206]);
  });

  it("keeps only the most recently used frames mounted", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    for (const port of [3201, 3202, 3203, 3204]) instanceTabs.open(port);
    expect(instanceTabs.getSnapshot().framedPorts).toEqual([3202, 3203, 3204]);
    expect(MAX_MOUNTED_FRAMES).toBe(3);
    instanceTabs.activate(3202);
    expect(instanceTabs.getSnapshot().framedPorts).toEqual([3203, 3204, 3202]);
    instanceTabs.activate(3201);
    expect(instanceTabs.getSnapshot().framedPorts).toEqual([3204, 3202, 3201]);
    expect(instanceTabs.getSnapshot().openPorts).toEqual([3201, 3202, 3203, 3204]);
  });

  it("treats only a frame named by the tab host as embedded", () => {
    vi.stubGlobal("window", { name: INSTANCE_TAB_FRAME_NAME });
    expect(isEmbeddedInstanceTab()).toBe(true);
    vi.stubGlobal("window", { name: "ide-preview" });
    expect(isEmbeddedInstanceTab()).toBe(false);
  });

  it("notifies subscribers only on change", () => {
    vi.stubGlobal("window", { localStorage: memoryStorage() });
    const listener = vi.fn();
    instanceTabs.subscribe(listener);
    instanceTabs.open(3206);
    instanceTabs.activate(3206);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("instanceOrigin", () => {
  it("keeps the page host name and protocol", () => {
    expect(instanceOrigin(3210, { hostname: "127.0.0.1", protocol: "http:" })).toBe(
      "http://127.0.0.1:3210",
    );
    expect(instanceOrigin(3210, { hostname: "localhost", protocol: "https:" })).toBe(
      "https://localhost:3210",
    );
    expect(instanceOrigin(3210, { hostname: "[::1]", protocol: "http:" })).toBe("http://[::1]:3210");
    expect(instanceOrigin(3210, { hostname: "::1", protocol: "http:" })).toBe("http://[::1]:3210");
  });
});

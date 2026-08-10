import { afterEach, describe, expect, it, vi } from "vitest";

import { recordVisualizationDebugResourceCounts } from "./visualizationDebugPerformanceProbe";

describe("visualizationDebugPerformanceProbe", () => {
  const testWindow = globalThis as typeof globalThis & Window;

  afterEach(() => {
    delete testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__;
    vi.unstubAllGlobals();
  });

  it("publishes a bounded viewport resource-count snapshot for runtime qualification", () => {
    vi.stubGlobal("window", testWindow);
    testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = {
      publishes: 0,
      scans: 0,
      viewportFrames: 0,
    };

    recordVisualizationDebugResourceCounts({
      geometries: 4,
      materials: 3,
      renderTargets: 1,
      textures: 2,
      workers: 1,
    });

    expect(testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.resourceCounts).toEqual({
      geometries: 4,
      materials: 3,
      renderTargets: 1,
      textures: 2,
      workers: 1,
    });
  });
});

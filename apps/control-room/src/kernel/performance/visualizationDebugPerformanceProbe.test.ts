import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VISUALIZATION_DEBUG_VIEWPORT_FRAME_REASON_LIMIT,
  recordVisualizationDebugCanvasLifecycle,
  recordVisualizationDebugPerformanceMetric,
  recordVisualizationDebugResourceCounts,
  recordVisualizationDebugViewportFrame,
} from "./visualizationDebugPerformanceProbe";

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

  it("counts root, event, and context lifecycle only while the opt-in probe exists", () => {
    vi.stubGlobal("window", testWindow);
    recordVisualizationDebugCanvasLifecycle("root-configure-started");
    testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = {
      publishes: 0,
      scans: 0,
      viewportFrames: 0,
    };

    recordVisualizationDebugCanvasLifecycle("root-configure-started");
    recordVisualizationDebugCanvasLifecycle("root-configure-completed");
    recordVisualizationDebugCanvasLifecycle("events-connected");
    recordVisualizationDebugCanvasLifecycle("events-disconnected");
    recordVisualizationDebugCanvasLifecycle("context-created");
    recordVisualizationDebugCanvasLifecycle("context-disposed");

    expect(testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__).toMatchObject({
      canvasContextsCreated: 1,
      canvasContextsDisposed: 1,
      canvasEventConnections: 1,
      canvasEventDisconnections: 1,
      canvasRootConfigureCompleted: 1,
      canvasRootConfigureStarted: 1,
    });
  });

  it("publishes one bounded opt-in snapshot for renderer work without polling", () => {
    vi.stubGlobal("window", testWindow);
    testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = {
      publishes: 0,
      scans: 0,
      viewportFrames: 0,
    };

    recordVisualizationDebugPerformanceMetric("topologyBuilds");
    recordVisualizationDebugPerformanceMetric("fieldDecodes", 2);
    recordVisualizationDebugPerformanceMetric("typedArrayCopiedBytes", 4096);
    recordVisualizationDebugPerformanceMetric("gpuUploadBytes", 2048);
    recordVisualizationDebugPerformanceMetric("cacheHits", 3);
    recordVisualizationDebugPerformanceMetric("cacheMisses");
    recordVisualizationDebugPerformanceMetric("cacheEvictions");

    expect(testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__).toMatchObject({
      cacheEvictions: 1,
      cacheHits: 3,
      cacheMisses: 1,
      fieldDecodes: 2,
      gpuUploadBytes: 2048,
      topologyBuilds: 1,
      typedArrayCopiedBytes: 4096,
    });
  });

  it("bounds unique frame reasons and counts dropped overflow deterministically", () => {
    vi.stubGlobal("window", testWindow);
    testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__ = {
      publishes: 0,
      scans: 0,
      viewportFrames: 0,
    };

    for (let index = 0; index <= VISUALIZATION_DEBUG_VIEWPORT_FRAME_REASON_LIMIT; index += 1) {
      recordVisualizationDebugViewportFrame(`reason-${index}`);
    }
    recordVisualizationDebugViewportFrame("reason-0");

    expect(testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__).toMatchObject({
      viewportFrameReasonsDropped: 1,
      viewportFrameReasonsOverflowed: true,
      viewportFrames: VISUALIZATION_DEBUG_VIEWPORT_FRAME_REASON_LIMIT + 2,
    });
    expect(
      Object.keys(
        testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.viewportFrameReasons ?? {},
      ),
    ).toHaveLength(VISUALIZATION_DEBUG_VIEWPORT_FRAME_REASON_LIMIT);
    expect(
      testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.viewportFrameReasons?.["reason-0"],
    ).toBe(2);
  });
});

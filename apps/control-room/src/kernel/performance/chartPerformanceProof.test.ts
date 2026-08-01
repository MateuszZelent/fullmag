import { describe, expect, it } from "vitest";

import {
  assertChartPerformanceProof,
  CHART_PERFORMANCE_PROOF_VERSION,
} from "./chartPerformanceProof.mjs";

function completeProof() {
  return {
    schema: "fullmag.chart-performance-proof",
    version: CHART_PERFORMANCE_PROOF_VERSION,
    recordedAt: "2026-07-26T00:00:00.000Z",
    build: {
      commit: "2054cdde572f73f10b3a28239b2d6064dfb3fdb7",
      mode: "production",
    },
    browser: {
      name: "chromium",
      version: "140.0.0.0",
    },
    dataset: {
      fixture: "analysis-small",
      checksum: "sha256:fixture",
      size: "small",
      rows: 128,
      series: 4,
    },
    scenario: {
      id: "analysis-open",
      phase: "cold",
      iteration: 1,
      sessionAbort: false,
    },
    timing: {
      samples: 1,
      p50Ms: 10,
      p95Ms: 10,
      longTasks: 0,
    },
    transport: {
      requests: 1,
      payloadBytes: 4096,
      cacheHits: 0,
      cacheMisses: 1,
      cancelledRequests: 0,
    },
    chart: {
      modelBuilds: 1,
      plannedPoints: 128,
      renderedPoints: 128,
      setOptionCalls: 1,
      redraws: 1,
      activeInstances: 1,
      createdInstances: 1,
      disposedInstances: 0,
    },
    lifecycle: {
      listeners: 2,
      observers: 1,
      workers: 0,
    },
    memory: {
      baselineHeapBytes: 10_000,
      peakHeapBytes: 12_000,
      retainedHeapBytes: 11_000,
    },
    viewport3d: {
      mounted: true,
      dirtyFrames: 0,
      fieldRequests: 0,
      topologyRequests: 0,
      unchangedBufferUploads: 0,
      contextLost: false,
      drawingBufferWidth: 800,
      drawingBufferHeight: 600,
      webglBufferDelta: 0,
    },
    cancellation: {
      requested: false,
      completed: false,
      adoptedAfterAbort: false,
    },
  };
}

describe("ChartPerformanceProof", () => {
  it("accepts a complete measured cold scenario", () => {
    expect(assertChartPerformanceProof(completeProof())).toEqual(
      completeProof(),
    );
  });

  it.each([
    ["transport.payloadBytes", (proof: ReturnType<typeof completeProof>) => {
      delete (proof.transport as Partial<typeof proof.transport>).payloadBytes;
    }],
    ["transport.cacheHits", (proof: ReturnType<typeof completeProof>) => {
      delete (proof.transport as Partial<typeof proof.transport>).cacheHits;
    }],
    ["chart.modelBuilds", (proof: ReturnType<typeof completeProof>) => {
      delete (proof.chart as Partial<typeof proof.chart>).modelBuilds;
    }],
    ["lifecycle.observers", (proof: ReturnType<typeof completeProof>) => {
      delete (proof.lifecycle as Partial<typeof proof.lifecycle>).observers;
    }],
    ["lifecycle.listeners", (proof: ReturnType<typeof completeProof>) => {
      delete (proof.lifecycle as Partial<typeof proof.lifecycle>).listeners;
    }],
    ["memory.retainedHeapBytes", (proof: ReturnType<typeof completeProof>) => {
      delete (proof.memory as Partial<typeof proof.memory>).retainedHeapBytes;
    }],
    ["viewport3d.contextLost", (proof: ReturnType<typeof completeProof>) => {
      delete (proof.viewport3d as Partial<typeof proof.viewport3d>).contextLost;
    }],
    ["cancellation.adoptedAfterAbort", (proof: ReturnType<typeof completeProof>) => {
      delete (proof.cancellation as Partial<typeof proof.cancellation>)
        .adoptedAfterAbort;
    }],
  ])("rejects missing %s evidence", (field, removeField) => {
    const proof = completeProof();
    removeField(proof);

    expect(() => assertChartPerformanceProof(proof)).toThrow(field);
  });

  it("rejects non-measured and non-finite metric values", () => {
    const proof = completeProof();
    proof.transport.payloadBytes = Number.NaN;

    expect(() => assertChartPerformanceProof(proof)).toThrow(
      "transport.payloadBytes",
    );
  });

  it("requires separate cold and warm scenario records", () => {
    const cold = completeProof();
    const warm = completeProof();
    warm.scenario.phase = "warm";
    warm.scenario.iteration = 2;

    expect(assertChartPerformanceProof(cold).scenario.phase).toBe("cold");
    expect(assertChartPerformanceProof(warm).scenario.phase).toBe("warm");
  });
});

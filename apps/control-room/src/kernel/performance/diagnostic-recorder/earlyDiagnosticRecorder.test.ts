import { describe, expect, it } from "vitest";

import { installEarlyDiagnosticRecorder } from "./earlyDiagnosticRecorder";

interface FakePerformanceEntry {
  decodedBodySize?: number;
  duration: number;
  encodedBodySize?: number;
  entryType: string;
  initiatorType?: string;
  name: string;
  startTime: number;
  transferSize?: number;
}

class FakePerformanceObserver {
  static instances: FakePerformanceObserver[] = [];
  static supportedEntryTypes = [
    "event",
    "long-animation-frame",
    "longtask",
    "measure",
    "navigation",
    "paint",
    "resource",
  ];

  observedType: string | null = null;

  constructor(
    private readonly callback: (list: {
      getEntries: () => FakePerformanceEntry[];
    }) => void,
  ) {
    FakePerformanceObserver.instances.push(this);
  }

  disconnect() {}

  emit(entries: FakePerformanceEntry[]) {
    this.callback({ getEntries: () => entries });
  }

  observe(options: { buffered?: boolean; type: string }) {
    this.observedType = options.type;
  }
}

function createTarget() {
  return {
    PerformanceObserver: FakePerformanceObserver,
    clearTimeout: () => undefined,
    location: { href: "http://localhost:3100/workspace" },
    performance: {
      memory: {
        jsHeapSizeLimit: 512,
        totalJSHeapSize: 256,
        usedJSHeapSize: 128,
      },
      now: () => 10,
      timeOrigin: 1_000,
    },
    setTimeout: () => 1,
  };
}

describe("early diagnostic recorder", () => {
  it("installs once, records startup marks, and drains bounded records", () => {
    FakePerformanceObserver.instances = [];
    const target = createTarget();
    const recorder = installEarlyDiagnosticRecorder({
      eventLoopLagProbe: false,
      maxRecords: 8,
      target,
    });
    const second = installEarlyDiagnosticRecorder({
      eventLoopLagProbe: false,
      target,
    });

    expect(recorder).toBe(second);
    expect(recorder?.snapshot().records.map((entry) => entry.name)).toContain(
      "instrumentation-client.loaded",
    );

    const drained = recorder?.drain() ?? [];
    expect(drained.length).toBeGreaterThan(0);
    expect(recorder?.snapshot().records).toEqual([]);
  });

  it("records supported long tasks, resources, and fullmag measures", () => {
    FakePerformanceObserver.instances = [];
    const target = createTarget();
    const recorder = installEarlyDiagnosticRecorder({
      eventLoopLagProbe: false,
      maxRecords: 16,
      target,
    });
    const longTaskObserver = FakePerformanceObserver.instances.find(
      (observer) => observer.observedType === "longtask",
    );
    const resourceObserver = FakePerformanceObserver.instances.find(
      (observer) => observer.observedType === "resource",
    );
    const measureObserver = FakePerformanceObserver.instances.find(
      (observer) => observer.observedType === "measure",
    );

    longTaskObserver?.emit([
      {
        duration: 130,
        entryType: "longtask",
        name: "self",
        startTime: 25,
      },
    ]);
    resourceObserver?.emit([
      {
        duration: 30,
        entryType: "resource",
        initiatorType: "fetch",
        name: "http://localhost:3100/v2/sessions/current/status",
        startTime: 30,
        transferSize: 2048,
      },
    ]);
    measureObserver?.emit([
      {
        duration: 55,
        entryType: "measure",
        name: "fullmag.viewport3d.buildViewport3DFieldRenderModel",
        startTime: 40,
      },
    ]);

    const snapshot = recorder?.snapshot();

    expect(snapshot?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durationMs: 130,
          lane: "main-thread",
          name: "browser.longtask",
          severity: "critical",
        }),
        expect.objectContaining({
          byteLength: 2048,
          lane: "api",
          name: "browser.resource",
        }),
        expect.objectContaining({
          durationMs: 55,
          lane: "viewport-3d",
          name: "fullmag.viewport3d.buildViewport3DFieldRenderModel",
        }),
      ]),
    );
  });

  it("drops low severity records before critical records when the buffer is full", () => {
    const target = createTarget();
    const recorder = installEarlyDiagnosticRecorder({
      eventLoopLagProbe: false,
      maxRecords: 2,
      target,
    });
    recorder?.drain();

    recorder?.record({
      kind: "mark",
      lane: "startup",
      name: "low-1",
      severity: "info",
    });
    recorder?.record({
      kind: "mark",
      lane: "main-thread",
      name: "critical-1",
      severity: "critical",
    });
    recorder?.record({
      kind: "mark",
      lane: "startup",
      name: "low-2",
      severity: "info",
    });

    const snapshot = recorder?.snapshot();
    expect(snapshot?.droppedCount).toBe(1);
    expect(snapshot?.records.map((entry) => entry.name)).toEqual([
      "critical-1",
      "low-2",
    ]);
  });

  it("returns null without a browser performance object", () => {
    expect(
      installEarlyDiagnosticRecorder({
        target: {
          clearTimeout: () => undefined,
          setTimeout: () => 1,
        },
      }),
    ).toBeNull();
  });
});

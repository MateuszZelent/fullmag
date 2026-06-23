import { describe, expect, it, vi } from "vitest";

import type { RequestDiagnosticRecord } from "../api/RequestDiagnosticsController";

import { startPerformanceMeasureDiagnostics } from "./performanceMeasureDiagnostics";

type MeasureEntry = Pick<PerformanceEntry, "duration" | "entryType" | "name" | "startTime">;

type ObserverCallback = (list: { getEntries: () => MeasureEntry[] }) => void;

class FakePerformanceObserver {
  static supportedEntryTypes = ["measure"];
  static latest: FakePerformanceObserver | null = null;

  readonly disconnect = vi.fn();
  readonly observe = vi.fn();

  constructor(private readonly callback: ObserverCallback) {
    FakePerformanceObserver.latest = this;
  }

  emit(entries: MeasureEntry[]): void {
    this.callback({ getEntries: () => entries });
  }
}

describe("performance measure diagnostics", () => {
  it("records fullmag performance measures into footer diagnostics", () => {
    const records: RequestDiagnosticRecord[] = [];
    const stop = startPerformanceMeasureDiagnostics({
      diagnostics: {
        record: (entry) => records.push(entry),
      },
      now: () => 9_999,
      observerConstructor: FakePerformanceObserver,
      timeOrigin: 1_000,
    });

    const observer = FakePerformanceObserver.latest;
    expect(observer).not.toBeNull();
    expect(observer?.observe).toHaveBeenCalledWith({
      buffered: true,
      type: "measure",
    });

    observer?.emit([
      {
        duration: 12.7,
        entryType: "measure",
        name: "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
        startTime: 50,
      },
      {
        duration: 99,
        entryType: "measure",
        name: "third-party.measure",
        startTime: 60,
      },
    ]);

    expect(records).toEqual([
      expect.objectContaining({
        byteLength: null,
        channel: "performance",
        detail:
          "performance measure;bucket=viewport-build;source=fullmag.viewport3d.buildViewport3DTopologyRenderModel;suppressedSinceLast=0",
        direction: "rx",
        durationMs: 12.7,
        messageType: "measure",
        method: "MEASURE",
        outcome: "ok",
        path: "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
        requestId: "performance-measure",
        status: null,
        timestampMs: 1_050,
      }),
    ]);

    stop();
    expect(observer?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("samples React render measures to avoid profiler feedback loops", () => {
    const records: RequestDiagnosticRecord[] = [];
    const stop = startPerformanceMeasureDiagnostics({
      diagnostics: {
        record: (entry) => records.push(entry),
      },
      observerConstructor: FakePerformanceObserver,
      timeOrigin: 1_000,
    });

    FakePerformanceObserver.latest?.emit([
      {
        duration: 1,
        entryType: "measure",
        name: "fullmag.react.render.Viewport3DModule.update",
        startTime: 50,
      },
      {
        duration: 2,
        entryType: "measure",
        name: "fullmag.react.render.Viewport3DModule.update",
        startTime: 500,
      },
      {
        duration: 3,
        entryType: "measure",
        name: "fullmag.react.render.Viewport3DModule.update",
        startTime: 1_100,
      },
    ]);

    expect(records).toEqual([
      expect.objectContaining({
        detail:
          "performance measure;bucket=react-render;source=fullmag.react.render.Viewport3DModule.update;suppressedSinceLast=0",
        durationMs: 1,
        path: "fullmag.react.render.Viewport3DModule.update",
        timestampMs: 1_050,
      }),
      expect.objectContaining({
        detail:
          "performance measure;bucket=react-render;source=fullmag.react.render.Viewport3DModule.update;suppressedSinceLast=1",
        durationMs: 3,
        path: "fullmag.react.render.Viewport3DModule.update",
        timestampMs: 2_100,
      }),
    ]);

    stop();
  });

  it("does not sample out critical React render measures", () => {
    const records: RequestDiagnosticRecord[] = [];
    startPerformanceMeasureDiagnostics({
      diagnostics: {
        record: (entry) => records.push(entry),
      },
      observerConstructor: FakePerformanceObserver,
      timeOrigin: 1_000,
    });

    FakePerformanceObserver.latest?.emit([
      {
        duration: 1,
        entryType: "measure",
        name: "fullmag.react.render.Viewport3DModule.update",
        startTime: 50,
      },
      {
        duration: 140,
        entryType: "measure",
        name: "fullmag.react.render.Viewport3DModule.update",
        startTime: 100,
      },
    ]);

    expect(records).toEqual([
      expect.objectContaining({ durationMs: 1 }),
      expect.objectContaining({
        detail: expect.stringContaining("suppressedSinceLast=0"),
        durationMs: 140,
      }),
    ]);
  });
});

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
        detail: "performance measure",
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
});

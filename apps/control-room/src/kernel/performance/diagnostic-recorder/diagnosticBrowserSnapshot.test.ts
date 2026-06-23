import { describe, expect, it } from "vitest";

import {
  diagnosticBrowserSnapshotToRecords,
  readDiagnosticBrowserSnapshot,
  recordDiagnosticBrowserSnapshot,
} from "./diagnosticBrowserSnapshot";
import { DIAGNOSTIC_EVENT_NAMES } from "./diagnosticRecorderTypes";

describe("diagnosticBrowserSnapshot", () => {
  it("captures browser identity, viewport, memory, and observer support", () => {
    const snapshot = readDiagnosticBrowserSnapshot(
      {
        PerformanceObserver: {
          supportedEntryTypes: ["longtask", "resource", "measure"],
        },
        devicePixelRatio: 2,
        innerHeight: 720,
        innerWidth: 1280,
        navigator: {
          hardwareConcurrency: 16,
          platform: "Linux x86_64",
          userAgent: "Fullmag Test Browser",
        },
        performance: {
          memory: {
            jsHeapSizeLimit: 1_000,
            totalJSHeapSize: 500,
            usedJSHeapSize: 250,
          },
        },
      },
      () => 100,
    );

    expect(snapshot).toEqual({
      devicePixelRatio: 2,
      hardwareConcurrency: 16,
      jsHeapSizeLimitBytes: 1_000,
      performanceObserverSupport: {
        event: false,
        "long-animation-frame": false,
        longtask: true,
        measure: true,
        navigation: false,
        paint: false,
        resource: true,
      },
      platform: "Linux x86_64",
      timestampMs: 100,
      totalJSHeapBytes: 500,
      usedJSHeapBytes: 250,
      userAgent: "Fullmag Test Browser",
      viewportHeight: 720,
      viewportWidth: 1280,
    });
  });

  it("converts snapshots to recorder streams without nested detail payloads", () => {
    const snapshot = readDiagnosticBrowserSnapshot(
      {
        PerformanceObserver: { supportedEntryTypes: [] },
        devicePixelRatio: 1,
        innerHeight: 600,
        innerWidth: 800,
        navigator: { hardwareConcurrency: 8, userAgent: "UA" },
        performance: {
          memory: {
            jsHeapSizeLimit: 10_000,
            totalJSHeapSize: 5_000,
            usedJSHeapSize: 2_500,
          },
        },
      },
      () => 200,
    );
    const records = diagnosticBrowserSnapshotToRecords(snapshot);

    expect(records[0]).toMatchObject({
      kind: "browser-snapshot",
      lane: "browser",
      name: "browser.snapshot",
    });
    expect(records[1]).toMatchObject({
      kind: "memory",
      name: DIAGNOSTIC_EVENT_NAMES.memorySnapshot,
      usedJSHeapBytes: 2_500,
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: "browser-metric",
        metricName: "js-heap-used",
        unit: "bytes",
        value: 2_500,
      }),
    );
  });

  it("records every snapshot record through the supplied recorder callback", () => {
    const records: unknown[] = [];
    const count = recordDiagnosticBrowserSnapshot(
      (record) => records.push(record),
      {
        devicePixelRatio: null,
        hardwareConcurrency: null,
        jsHeapSizeLimitBytes: null,
        performanceObserverSupport: {
          event: false,
          "long-animation-frame": false,
          longtask: false,
          measure: false,
          navigation: false,
          paint: false,
          resource: false,
        },
        platform: null,
        timestampMs: 300,
        totalJSHeapBytes: null,
        usedJSHeapBytes: null,
        userAgent: null,
        viewportHeight: null,
        viewportWidth: null,
      },
    );

    expect(count).toBe(2);
    expect(records).toHaveLength(2);
  });
});

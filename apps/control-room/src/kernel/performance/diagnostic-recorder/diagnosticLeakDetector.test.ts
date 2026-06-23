import { describe, expect, it } from "vitest";

import {
  compareDiagnosticLeakSnapshots,
  diagnosticLeakComparisonToRecord,
  type DiagnosticLeakSnapshot,
} from "./diagnosticLeakDetector";
import { DIAGNOSTIC_EVENT_NAMES } from "./diagnosticRecorderTypes";

function snapshot(
  patch: Partial<DiagnosticLeakSnapshot> = {},
): DiagnosticLeakSnapshot {
  return {
    activeWorkers: 0,
    dirtyFramesAfterIdle: 0,
    jsHeapUsedBytes: 100,
    kind: "before",
    moduleOwnedResourceCount: 0,
    objectUrlCount: 0,
    resourceCacheBytes: 0,
    subscriptionCount: 0,
    timestampMs: 1_000,
    totalTrackedBytes: 0,
    viewportCacheBytes: 0,
    webglEstimatedBytes: 0,
    ...patch,
  };
}

describe("diagnosticLeakDetector", () => {
  it("classifies clean after-unmount snapshots as ok", () => {
    expect(
      compareDiagnosticLeakSnapshots(
        snapshot(),
        snapshot({ kind: "after-unmount", timestampMs: 2_000 }),
      ),
    ).toMatchObject({
      classification: "ok",
      reasons: [],
    });
  });

  it("confirms leaks when module-owned resources remain after unmount", () => {
    const comparison = compareDiagnosticLeakSnapshots(
      snapshot(),
      snapshot({
        kind: "after-unmount",
        moduleOwnedResourceCount: 2,
        timestampMs: 2_000,
        totalTrackedBytes: 4096,
        webglEstimatedBytes: 4096,
      }),
    );

    expect(comparison.classification).toBe("leak-confirmed");
    expect(comparison.reasons).toContain(
      "module-owned resources remain after unmount",
    );
    expect(diagnosticLeakComparisonToRecord(comparison)).toMatchObject({
      estimatedWebGLBytes: 4096,
      name: DIAGNOSTIC_EVENT_NAMES.leakCheck,
      severity: "critical",
      trackedBytes: 4096,
    });
  });

  it("suspects leaks for large heap growth and dirty idle frames", () => {
    const comparison = compareDiagnosticLeakSnapshots(
      snapshot({ jsHeapUsedBytes: 10 }),
      snapshot({
        dirtyFramesAfterIdle: 3,
        jsHeapUsedBytes: 30 * 1024 * 1024,
        kind: "after-quantity-loop",
      }),
    );

    expect(comparison).toMatchObject({
      classification: "leak-suspected",
      deltas: { jsHeapUsedBytes: 30 * 1024 * 1024 - 10 },
      reasons: [
        "JS heap grew beyond the leak warning threshold",
        "viewport produced dirty frames after idle",
      ],
    });
  });

  it("watches smaller tracked growth below leak thresholds", () => {
    expect(
      compareDiagnosticLeakSnapshots(
        snapshot(),
        snapshot({
          kind: "after-load",
          objectUrlCount: 1,
          timestampMs: 2_000,
        }),
      ),
    ).toMatchObject({
      classification: "watch",
      reasons: ["tracked memory grew but stayed below leak thresholds"],
    });
  });
});

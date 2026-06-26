import { describe, expect, it, vi } from "vitest";

import {
  createDiagnosticRecordFromViewport3DBuildDiagnostic,
  getViewport3DBuildDiagnosticsSnapshotVersion,
  getViewport3DBuildFallbackDiagnosticsSnapshot,
  getViewport3DBuildPipelineDiagnosticsSnapshot,
  recordViewport3DBuildDiagnostic,
  resetViewport3DBuildFallbackDiagnosticsForTests,
  resetViewport3DBuildPipelineDiagnosticsForTests,
  subscribeViewport3DBuildDiagnostics,
} from "./viewport3dBuildDiagnostics";
import type { Viewport3DBuildDiagnosticRecord } from "./viewport3dBuildEngineTypes";

function buildDiagnosticRecord(
  patch: Partial<Viewport3DBuildDiagnosticRecord> = {},
): Viewport3DBuildDiagnosticRecord {
  return {
    abortedAtMs: null,
    droppedBecauseObsolete: false,
    fallbackReason: null,
    finishedAtMs: 90,
    inputBytes: 64,
    itemCount: 4,
    key: "vector-glyph:topology-1:field-1",
    kind: "viewport-3d-build-job",
    lane: "vector-glyph",
    mainAdoptMs: 0,
    mainUploadMs: 0,
    outputBytes: 128,
    queuedAtMs: 10,
    queueWaitMs: 20,
    revisionSummary: "topology=1 field=1",
    startedAtMs: 30,
    state: "ready",
    totalWallMs: 80,
    transferMs: 0,
    workerComputeMs: 60,
    ...patch,
  };
}

describe("viewport3dBuildDiagnostics", () => {
  it("increments a stable snapshot version when build diagnostics change", () => {
    resetViewport3DBuildPipelineDiagnosticsForTests();
    resetViewport3DBuildFallbackDiagnosticsForTests();
    const initial = getViewport3DBuildDiagnosticsSnapshotVersion();

    recordViewport3DBuildDiagnostic(
      buildDiagnosticRecord({
        key: "vector-segments:part-a",
        lane: "vector-glyph",
        queueWaitMs: 7,
      }),
    );

    expect(getViewport3DBuildDiagnosticsSnapshotVersion()).toBe(initial + 1);

    recordViewport3DBuildDiagnostic(
      buildDiagnosticRecord({
        fallbackReason: "worker-unavailable",
        key: "vector-segments:part-a",
        lane: "vector-glyph",
        queueWaitMs: 7,
      }),
    );

    expect(getViewport3DBuildDiagnosticsSnapshotVersion()).toBe(initial + 2);
    resetViewport3DBuildPipelineDiagnosticsForTests();
    resetViewport3DBuildFallbackDiagnosticsForTests();
  });

  it("keeps compact pipeline timing snapshots from terminal build records", () => {
    resetViewport3DBuildPipelineDiagnosticsForTests();

    recordViewport3DBuildDiagnostic(
      buildDiagnosticRecord({
        key: "vector-segments:part-a",
        lane: "vector-glyph",
        mainAdoptMs: 4,
        mainUploadMs: 3,
        queueWaitMs: 7,
        transferMs: 2,
        workerComputeMs: 11,
      }),
    );
    recordViewport3DBuildDiagnostic(
      buildDiagnosticRecord({
        key: "field-color:part-a",
        lane: "field-color",
        mainAdoptMs: 1,
        mainUploadMs: 6,
        queueWaitMs: 2,
        transferMs: 5,
        workerComputeMs: 13,
      }),
    );

    expect(getViewport3DBuildPipelineDiagnosticsSnapshot()).toEqual([
      {
        lane: "field-color",
        mainAdoptMs: 1,
        mainUploadMs: 6,
        queueWaitMs: 2,
        transferMs: 5,
        workerComputeMs: 13,
      },
      {
        lane: "vector-glyph",
        mainAdoptMs: 4,
        mainUploadMs: 3,
        queueWaitMs: 7,
        transferMs: 2,
        workerComputeMs: 11,
      },
    ]);

    resetViewport3DBuildPipelineDiagnosticsForTests();
  });

  it("keeps a compact fallback snapshot from terminal build records", () => {
    resetViewport3DBuildFallbackDiagnosticsForTests();

    recordViewport3DBuildDiagnostic(
      buildDiagnosticRecord({
        fallbackReason: "worker-unavailable",
        key: "vector-segments:part-a",
        lane: "vector-glyph",
      }),
    );
    recordViewport3DBuildDiagnostic(
      buildDiagnosticRecord({
        fallbackReason: "worker-error",
        key: "vector-segments:part-b",
        lane: "vector-glyph",
        revisionSummary: "topology=2 field=2",
      }),
    );

    expect(getViewport3DBuildFallbackDiagnosticsSnapshot()).toEqual([
      {
        count: 2,
        key: "vector-segments:part-b",
        lane: "vector-glyph",
        reason: "worker-error",
        revisionSummary: "topology=2 field=2",
        timestampMs: 90,
      },
    ]);

    resetViewport3DBuildFallbackDiagnosticsForTests();
  });

  it("converts build-engine diagnostics to diagnostic-recorder records", () => {
    const record = createDiagnosticRecordFromViewport3DBuildDiagnostic(
      buildDiagnosticRecord({
        fallbackReason: "worker-unavailable",
      }),
    );

    expect(record).toMatchObject({
      byteLength: 128,
      buildKey: "vector-glyph:topology-1:field-1",
      buildLane: "vector-glyph",
      buildState: "ready",
      durationMs: 80,
      inputBytes: 64,
      itemCount: 4,
      kind: "viewport-3d-build-job",
      lane: "viewport-3d",
      name: "fullmag.viewport3d.build-engine.vector-glyph",
      outputBytes: 128,
      queueWaitMs: 20,
      severity: "warning",
      startTimeMs: 10,
      timestampMs: 90,
      workerComputeMs: 60,
    });
    expect(record.detail).toMatchObject({
      buildKey: "vector-glyph:topology-1:field-1",
      buildLane: "vector-glyph",
      fallbackReason: "worker-unavailable",
      itemCount: 4,
      queueWaitMs: 20,
      revisionSummary: "topology=1 field=1",
      state: "ready",
      workerComputeMs: 60,
    });
  });

  it("publishes build diagnostics to current subscribers only", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeViewport3DBuildDiagnostics(listener);
    const first = buildDiagnosticRecord({ key: "vector-glyph:first" });
    const second = buildDiagnosticRecord({ key: "vector-glyph:second" });

    recordViewport3DBuildDiagnostic(first);
    unsubscribe();
    recordViewport3DBuildDiagnostic(second);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(first);
  });
});

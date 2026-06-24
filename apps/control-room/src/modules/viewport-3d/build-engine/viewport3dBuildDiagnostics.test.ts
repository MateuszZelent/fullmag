import { describe, expect, it, vi } from "vitest";

import {
  createDiagnosticRecordFromViewport3DBuildDiagnostic,
  recordViewport3DBuildDiagnostic,
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
  it("converts build-engine diagnostics to diagnostic-recorder records", () => {
    const record = createDiagnosticRecordFromViewport3DBuildDiagnostic(
      buildDiagnosticRecord({
        fallbackReason: "worker-unavailable",
      }),
    );

    expect(record).toMatchObject({
      byteLength: 128,
      durationMs: 80,
      kind: "measure",
      lane: "viewport-3d",
      name: "fullmag.viewport3d.build-engine.vector-glyph",
      severity: "warning",
      startTimeMs: 10,
      timestampMs: 90,
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

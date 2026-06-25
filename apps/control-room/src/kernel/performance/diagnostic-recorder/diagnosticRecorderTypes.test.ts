import { describe, expect, it } from "vitest";

import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";

import {
  DIAGNOSTIC_ARTIFACT_VERSION,
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticArtifactV1,
  type DiagnosticMemoryRecord,
  type DiagnosticRecord,
  normalizeDiagnosticRequestRecord,
} from "./diagnosticRecorderTypes";

const MAGNETIZATION_FIELD_VECTOR_PATH = DATA_FIELD_VECTOR_PATH.replace(
  "{quantity_id}",
  "m",
);

function baseRecord(patch: Partial<DiagnosticRecord> = {}): DiagnosticRecord {
  return {
    byteLength: null,
    detail: {},
    droppedCount: 0,
    durationMs: null,
    id: "record-1",
    kind: "mark",
    lane: "startup",
    name: DIAGNOSTIC_EVENT_NAMES.instrumentationLoaded,
    severity: "info",
    startTimeMs: 0,
    timestampMs: 1_000,
    ...patch,
  };
}

describe("diagnostic recorder types", () => {
  it("pins the artifact schema version to v1", () => {
    const artifact = {
      artifactVersion: DIAGNOSTIC_ARTIFACT_VERSION,
      manifest: {
        artifactVersion: DIAGNOSTIC_ARTIFACT_VERSION,
        branch: "salvage/mixed-fem-viewport-35232294",
        browserName: "chromium",
        browserVersion: "test",
        commit: "35232294",
        createdAtIso: "2026-06-23T00:00:00.000Z",
        profile: "forensic",
        scenario: "boot",
        url: "http://localhost:3100/workspace",
      },
      streams: {
        browserMetrics: [],
        console: [],
        memory: [],
        performance: [],
        react: [],
        requests: [],
        resources: [],
        timeline: [baseRecord()],
        viewport3dBuild: [],
        viewport3dWorkerPools: [],
        viewport3d: [],
      },
      summary: {
        criticalCount: 0,
        droppedCount: 0,
        recordCount: 1,
        slowestRecord: null,
        warningCount: 0,
      },
      suspectReport: {
        generatedAtIso: "2026-06-23T00:00:00.000Z",
        suspects: [],
        text: "No suspects.",
      },
      viewport3dBuildSummary: {
        lanes: [],
        totalJobs: 0,
      },
      viewport3dVisibleRevisionSummary: {
        fieldRevision: null,
        invalidSuppressedTargets: [],
        staleCompatibleTargets: [],
        stalePhysicalTargets: [],
        targetVisualizationRevision: null,
        topologyRevision: null,
      },
    } satisfies DiagnosticArtifactV1;

    expect(artifact.artifactVersion).toBe(1);
    expect(artifact.manifest.artifactVersion).toBe(1);
  });

  it("requires diagnostic records to carry timestamp, lane, name, and severity", () => {
    const record = baseRecord({
      lane: "main-thread",
      name: DIAGNOSTIC_EVENT_NAMES.longTask,
      severity: "critical",
    });

    expect(record).toMatchObject({
      lane: "main-thread",
      name: "browser.longtask",
      severity: "critical",
      timestampMs: 1_000,
    });
  });

  it("normalizes request records without storing response bodies or secrets", () => {
    const request = normalizeDiagnosticRequestRecord({
      ...baseRecord({
        byteLength: 4096,
        durationMs: 42,
        kind: "request",
        lane: "api",
        name: DIAGNOSTIC_EVENT_NAMES.requestFinished,
      }),
      contentType: "application/json",
      detail: {
        authorization: "Bearer secret",
        body: "{\"large\":true}",
        cookie: "sid=secret",
        responseBody: "{\"field\":\"payload\"}",
        route: "data/fields",
      },
      etag: "\"field-1\"",
      method: "GET",
      outcome: "ok",
      path: MAGNETIZATION_FIELD_VECTOR_PATH,
      query: "component=full",
      requestId: "req-1",
      resourceKey: "data/fields/m/samples/vector?component=full",
      status: 200,
    });

    expect(request.detail).toEqual({ route: "data/fields" });
    expect(JSON.stringify(request)).not.toContain("responseBody");
    expect(JSON.stringify(request)).not.toContain("Bearer secret");
    expect(JSON.stringify(request)).not.toContain("sid=secret");
  });

  it("keeps unknown JS heap and estimated WebGL memory as separate fields", () => {
    const memory = {
      ...baseRecord({
        byteLength: 16 * 1024 * 1024,
        kind: "memory",
        lane: "memory",
        name: DIAGNOSTIC_EVENT_NAMES.memorySnapshot,
      }),
      estimatedWebGLBytes: 12 * 1024 * 1024,
      jsHeapLimitBytes: null,
      totalJSHeapBytes: null,
      trackedBytes: 16 * 1024 * 1024,
      usedJSHeapBytes: null,
    } satisfies DiagnosticMemoryRecord;

    expect(memory.usedJSHeapBytes).toBeNull();
    expect(memory.estimatedWebGLBytes).toBe(12 * 1024 * 1024);
    expect(memory.trackedBytes).toBe(16 * 1024 * 1024);
  });
});

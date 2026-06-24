import { describe, expect, it } from "vitest";

import { buildDiagnosticSuspectReport } from "./diagnosticSuspectReport";
import {
  DIAGNOSTIC_ARTIFACT_VERSION,
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticArtifactV1,
} from "./diagnosticRecorderTypes";

function artifact(
  streams: Partial<DiagnosticArtifactV1["streams"]>,
): Omit<DiagnosticArtifactV1, "suspectReport"> {
  return {
    artifactVersion: DIAGNOSTIC_ARTIFACT_VERSION,
    manifest: {
      artifactVersion: DIAGNOSTIC_ARTIFACT_VERSION,
      branch: null,
      browserName: null,
      browserVersion: null,
      commit: null,
      createdAtIso: "2026-06-23T20:00:00.000Z",
      profile: "forensic",
      scenario: "viewport-3d",
      url: null,
    },
    streams: {
      browserMetrics: [],
      console: [],
      memory: [],
      performance: [],
      react: [],
      requests: [],
      resources: [],
      timeline: [],
      viewport3dBuild: [],
      viewport3dWorkerPools: [],
      viewport3d: [],
      ...streams,
    },
    summary: {
      criticalCount: 0,
      droppedCount: 0,
      recordCount: 0,
      slowestRecord: null,
      warningCount: 0,
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
  };
}

describe("buildDiagnosticSuspectReport", () => {
  it("identifies topology build, repeated field fetches, unreleased texture, and startup console errors", () => {
    const report = buildDiagnosticSuspectReport(
      artifact({
        console: [
          {
            byteLength: null,
            detail: {},
            droppedCount: 0,
            durationMs: null,
            id: "console-1",
            kind: "console",
            lane: "console",
            level: "error",
            message: "startup render failed",
            name: "console.error",
            severity: "critical",
            source: "startup",
            startTimeMs: null,
            timestampMs: 10,
          },
        ],
        requests: [0, 1, 2].map((index) => ({
          byteLength: 1024,
          contentType: "application/octet-stream",
          detail: {},
          droppedCount: 0,
          durationMs: 120 + index,
          etag: null,
          id: `request-${index}`,
          kind: "request",
          lane: "api",
          method: "GET",
          name: DIAGNOSTIC_EVENT_NAMES.requestFinished,
          outcome: "ok",
          path: "/v2/sessions/current/data/field-vector/m",
          query: "component=full",
          requestId: `req-${index}`,
          resourceKey: "field-vector:m",
          severity: "warning",
          startTimeMs: null,
          status: 200,
          timestampMs: 20 + index,
        })),
        viewport3d: [
          {
            byteLength: null,
            contextLost: null,
            detail: { resourceId: "texture:m", kind: "texture" },
            dirtyReason: null,
            droppedCount: 0,
            durationMs: null,
            geometries: 0,
            id: "tracked-texture",
            kind: "viewport-3d",
            lane: "viewport-3d",
            materials: 0,
            name: DIAGNOSTIC_EVENT_NAMES.viewport3DResourceTracked,
            renderTargets: 0,
            severity: "info",
            startTimeMs: null,
            textures: 1,
            timestampMs: 5,
            workers: 0,
          },
          {
            byteLength: null,
            contextLost: null,
            detail: { source: "topology" },
            dirtyReason: null,
            droppedCount: 0,
            durationMs: 500,
            geometries: 0,
            id: "topology-build",
            kind: "measure",
            lane: "viewport-3d",
            materials: 0,
            name: "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
            renderTargets: 0,
            severity: "critical",
            startTimeMs: 10,
            textures: 1,
            timestampMs: 510,
            workers: 0,
          },
        ],
      }),
      () => 2_000,
    );

    expect(report.suspects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: expect.stringContaining("500"),
        }),
        expect.objectContaining({
          reason: expect.stringContaining("repeated request/resource key"),
        }),
        expect.objectContaining({
          reason: "unreleased viewport 3D resource: texture:m",
        }),
        expect.objectContaining({
          reason: expect.stringContaining("startup render failed"),
        }),
      ]),
    );
    expect(report.text).toContain("Top Suspects");
  });

  it("classifies viewport 3D build-engine phase bottlenecks and stale visible targets", () => {
    const report = buildDiagnosticSuspectReport(
      artifact({
        viewport3dBuild: [
          {
            byteLength: 4096,
            buildKey: "vector-glyph:key",
            buildLane: "vector-glyph",
            buildState: "ready",
            detail: {
              buildLane: "vector-glyph",
              displayedRevision: "field-1",
              targetKey: "part:__air__",
              targetRevision: "field-2",
              visibleState: "stale-physical",
            },
            displayedRevision: "field-1",
            droppedBecauseObsolete: false,
            droppedCount: 0,
            durationMs: 2_000,
            fallbackReason: null,
            id: "build-vector",
            inputBytes: 2048,
            itemCount: 1200,
            kind: "viewport-3d-build-job",
            lane: "viewport-3d",
            mainAdoptMs: 12,
            mainUploadMs: 18,
            name: "fullmag.viewport3d.build-engine.vector-glyph",
            outputBytes: 4096,
            queueWaitMs: 1_400,
            revisionSummary: "topology=1 field=2",
            severity: "warning",
            startTimeMs: 0,
            targetRevision: "field-2",
            timestampMs: 2_000,
            transferMs: 20,
            visibleState: "stale-physical",
            workerComputeMs: 550,
          },
        ],
      }),
      () => 2_000,
    );

    expect(report.suspects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.objectContaining({ suspectCategory: "worker-queue" }),
          reason: expect.stringContaining("queue bottleneck"),
        }),
        expect.objectContaining({
          detail: expect.objectContaining({ suspectCategory: "visible-stale" }),
          reason: expect.stringContaining("stale physical"),
        }),
      ]),
    );
    expect(report.text).toContain("## Suspect Sections");
    expect(report.text).toContain("Queue Bottleneck");
    expect(report.text).toContain("Visible Stale Revision");
  });

  it("keeps legacy async viewport 3D wall-time measures out of the suspect ranking", () => {
    const report = buildDiagnosticSuspectReport(
      artifact({
        performance: [
          {
            byteLength: null,
            detail: {
              bucket: "viewport-upload",
              source: "fullmag.viewport3d.uploadVectorGlyphMatrices",
            },
            droppedCount: 0,
            durationMs: 15_000,
            id: "legacy-upload-measure",
            kind: "measure",
            lane: "viewport-3d",
            name: "fullmag.viewport3d.uploadVectorGlyphMatrices",
            severity: "critical",
            startTimeMs: 0,
            timestampMs: 15_000,
          },
        ],
        viewport3dBuild: [
          {
            byteLength: 4096,
            buildKey: "vector-glyph-upload:key",
            buildLane: "vector-glyph-upload",
            buildState: "ready",
            detail: {
              buildLane: "vector-glyph-upload",
              maxFrameUploadMs: 1.9,
              totalWallMs: 15_000,
            },
            displayedRevision: null,
            droppedBecauseObsolete: false,
            droppedCount: 0,
            durationMs: 1.9,
            fallbackReason: null,
            id: "vector-upload",
            inputBytes: 4096,
            itemCount: 12,
            kind: "viewport-3d-build-job",
            lane: "viewport-3d",
            mainAdoptMs: 0,
            mainUploadMs: 1.9,
            name: "fullmag.viewport3d.gpu-upload.vector-glyph",
            outputBytes: 4096,
            queueWaitMs: 0,
            revisionSummary: "frames=6 chunks=12 bytes=4096",
            severity: "info",
            startTimeMs: 0,
            targetRevision: "field-2",
            timestampMs: 15_000,
            transferMs: 0,
            visibleState: "ready-current",
            workerComputeMs: 0,
          },
        ],
      }),
      () => 2_000,
    );

    expect(report.suspects).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: expect.stringContaining("uploadVectorGlyphMatrices"),
        }),
      ]),
    );
    expect(report.suspects).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.objectContaining({ suspectCategory: "gpu-upload" }),
        }),
      ]),
    );
  });
});

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
});

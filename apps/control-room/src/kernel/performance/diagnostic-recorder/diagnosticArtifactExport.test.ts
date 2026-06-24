import { describe, expect, it } from "vitest";

import { DiagnosticRecorderController } from "./DiagnosticRecorderController";
import {
  buildDiagnosticArtifactV1,
  serializeDiagnosticArtifactJson,
  serializeDiagnosticStreamNdjson,
} from "./diagnosticArtifactExport";
import { DIAGNOSTIC_EVENT_NAMES } from "./diagnosticRecorderTypes";

describe("diagnosticArtifactExport", () => {
  it("builds a v1 artifact with generated suspect report", () => {
    const controller = new DiagnosticRecorderController({
      config: { enabled: true, profile: "forensic", scenario: "boot" },
      now: () => 1_000,
    });
    controller.record({
      byteLength: null,
      detail: { source: "topology" },
      droppedCount: 0,
      durationMs: 500,
      id: "slow-topology",
      kind: "measure",
      lane: "viewport-3d",
      name: "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
      severity: "critical",
      startTimeMs: 0,
      timestampMs: 500,
    });

    const artifact = buildDiagnosticArtifactV1(
      controller.getSnapshot(),
      { browserName: "chromium", commit: "abc123" },
      () => 2_000,
    );

    expect(artifact).toMatchObject({
      artifactVersion: 1,
      manifest: {
        browserName: "chromium",
        commit: "abc123",
        profile: "forensic",
        scenario: "boot",
      },
      suspectReport: {
        suspects: [
          expect.objectContaining({
            reason: expect.stringContaining(
              "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
            ),
          }),
        ],
      },
    });
  });

  it("builds viewport 3D build and visible stale summaries", () => {
    const controller = new DiagnosticRecorderController({
      config: { enabled: true, profile: "forensic", scenario: "viewport-3d" },
      now: () => 1_000,
    });
    controller.record({
      byteLength: 16_384,
      buildKey: "vector-glyph:key",
      buildLane: "vector-glyph",
      buildState: "ready",
      detail: {
        buildLane: "vector-glyph",
        displayedRevision: "field-1",
        targetKey: "part:__air__",
        targetRevision: "field-2",
        topologyRevision: "topology-1",
        visibleState: "stale-physical",
      },
      displayedRevision: "field-1",
      droppedBecauseObsolete: false,
      droppedCount: 0,
      durationMs: 2_400,
      fallbackReason: null,
      id: "build-vector",
      inputBytes: 8_192,
      itemCount: 1200,
      kind: "viewport-3d-build-job",
      lane: "viewport-3d",
      mainAdoptMs: 16,
      mainUploadMs: 20,
      name: "fullmag.viewport3d.build-engine.vector-glyph",
      outputBytes: 16_384,
      queueWaitMs: 1_800,
      revisionSummary: "topology=topology-1 field=field-2",
      severity: "warning",
      startTimeMs: 0,
      targetRevision: "field-2",
      timestampMs: 2_400,
      transferMs: 12,
      visibleState: "stale-physical",
      workerComputeMs: 552,
    });

    const artifact = controller.exportArtifact();

    expect(artifact.streams.viewport3dBuild).toHaveLength(1);
    expect(artifact.viewport3dBuildSummary.lanes).toEqual([
      expect.objectContaining({
        jobs: 1,
        lane: "vector-glyph",
        queueWaitMaxMs: 1800,
        workerComputeMaxMs: 552,
      }),
    ]);
    expect(artifact.viewport3dVisibleRevisionSummary).toMatchObject({
      topologyRevision: "topology-1",
      stalePhysicalTargets: [
        expect.objectContaining({
          displayedRevision: "field-1",
          targetKey: "part:__air__",
          targetRevision: "field-2",
        }),
      ],
    });
    expect(artifact.suspectReport.text).toContain("Queue Bottleneck");
    expect(artifact.suspectReport.text).toContain("Visible Stale Revision");
  });

  it("serializes JSON and NDJSON after redacting dangerous detail keys", () => {
    const controller = new DiagnosticRecorderController({
      config: { enabled: true },
    });
    controller.record({
      byteLength: null,
      detail: { source: "test", token: "secret" },
      droppedCount: 0,
      durationMs: null,
      id: "mark-1",
      kind: "mark",
      lane: "startup",
      name: DIAGNOSTIC_EVENT_NAMES.instrumentationLoaded,
      severity: "info",
      startTimeMs: null,
      timestampMs: 1,
    });

    const artifactJson = serializeDiagnosticArtifactJson(
      controller.exportArtifact(),
    );
    const ndjson = serializeDiagnosticStreamNdjson(
      controller.getSnapshot().streams.timeline,
    );

    expect(artifactJson).toContain("\"source\": \"test\"");
    expect(artifactJson).not.toContain("secret");
    expect(ndjson).toContain("\"source\":\"test\"");
    expect(ndjson).not.toContain("secret");
  });
});

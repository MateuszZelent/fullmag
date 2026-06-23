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

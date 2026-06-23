import { describe, expect, it, vi } from "vitest";

import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";

import { DiagnosticRecorderController } from "./DiagnosticRecorderController";
import { DIAGNOSTIC_EVENT_NAMES, type DiagnosticRecord } from "./diagnosticRecorderTypes";

function record(patch: Partial<DiagnosticRecord> = {}): DiagnosticRecord {
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
    startTimeMs: null,
    timestampMs: 1_000,
    ...patch,
  };
}

describe("DiagnosticRecorderController", () => {
  it("drains early records once into the timeline stream", () => {
    const earlyDrain = vi.fn(() => [
      record({ id: "early-1", name: DIAGNOSTIC_EVENT_NAMES.kernelCreated }),
    ]);
    const controller = new DiagnosticRecorderController({
      config: { enabled: true },
      earlyRecorder: {
        drain: earlyDrain,
        exportArtifact: () => ({ droppedCount: 0, records: [], url: null }),
        mark: vi.fn(),
        record: vi.fn(),
        snapshot: () => ({
          droppedCount: 0,
          maxRecords: 512,
          records: [],
          stopped: false,
        }),
        stop: vi.fn(),
      },
    });

    expect(controller.drainEarlyRecorder()).toBe(1);
    expect(controller.getSnapshot().streams.timeline).toEqual([
      expect.objectContaining({ id: "early-1" }),
    ]);
    expect(earlyDrain).toHaveBeenCalledTimes(1);
  });

  it("records critical events while disabled and mirrors them to legacy diagnostics", () => {
    const legacyRecords: unknown[] = [];
    const controller = new DiagnosticRecorderController({
      config: { enabled: false },
      diagnostics: {
        record: (entry: unknown) => legacyRecords.push(entry),
      } as never,
    });

    controller.record(
      record({
        durationMs: 140,
        lane: "main-thread",
        name: DIAGNOSTIC_EVENT_NAMES.longTask,
        severity: "critical",
      }),
    );

    expect(controller.getSnapshot().summary.criticalCount).toBe(1);
    expect(legacyRecords).toEqual([
      expect.objectContaining({
        channel: "performance",
        durationMs: 140,
        path: "fullmag.diagnostic.browser.longtask",
      }),
    ]);
  });

  it("returns a stable snapshot reference until the recorder changes", () => {
    const controller = new DiagnosticRecorderController({
      config: { enabled: true },
    });

    const firstSnapshot = controller.getSnapshot();

    expect(controller.getSnapshot()).toBe(firstSnapshot);

    controller.mark("workspace.settled");
    const changedSnapshot = controller.getSnapshot();

    expect(changedSnapshot).not.toBe(firstSnapshot);
    expect(controller.getSnapshot()).toBe(changedSnapshot);
  });

  it("evicts low-severity records before critical records", () => {
    const controller = new DiagnosticRecorderController({
      config: { enabled: true, maxRecords: 2 },
    });

    controller.record(record({ id: "low-1", name: "low-1" }));
    controller.record(
      record({
        id: "critical-1",
        name: "critical-1",
        severity: "critical",
      }),
    );
    controller.record(record({ id: "low-2", name: "low-2" }));

    const snapshot = controller.getSnapshot();
    expect(snapshot.droppedCount).toBe(1);
    expect(snapshot.streams.timeline.map((entry) => entry.id)).toEqual([
      "critical-1",
      "low-2",
    ]);
  });

  it("exports a v1 artifact with summary data", () => {
    const controller = new DiagnosticRecorderController({
      config: { enabled: true, profile: "forensic", scenario: "boot" },
      now: () => 1_000,
    });
    controller.mark("workspace.settled");

    const artifact = controller.exportArtifact();

    expect(artifact.artifactVersion).toBe(1);
    expect(artifact.manifest.profile).toBe("forensic");
    expect(artifact.summary.recordCount).toBe(1);
    expect(artifact.streams.timeline[0]).toEqual(
      expect.objectContaining({ name: "workspace.settled" }),
    );
  });

  it("bridges request diagnostics into the request stream without response bodies", () => {
    const diagnostics = new RequestDiagnosticsController();
    const controller = new DiagnosticRecorderController({
      config: { enabled: true },
      diagnostics,
      now: () => 5_000,
    });

    diagnostics.record({
      byteLength: 256,
      channel: "http",
      contentType: "application/json",
      detail: "responseBody=secret-body",
      direction: "rx",
      durationMs: 40,
      etag: "\"field-1\"",
      method: "GET",
      outcome: "ok",
      path: "/v2/sessions/current/data/field-vector/m?component=full",
      requestId: "req-1",
      resourceKey: "/v2/sessions/current/data/field-vector/m?component=full",
      status: 200,
      timestampMs: 1_040,
    });

    expect(controller.getSnapshot().streams.requests).toEqual([
      expect.objectContaining({
        byteLength: 256,
        detail: expect.objectContaining({ detail: "[redacted]" }),
        durationMs: 40,
        etag: "\"field-1\"",
        method: "GET",
        name: DIAGNOSTIC_EVENT_NAMES.requestFinished,
        path: "/v2/sessions/current/data/field-vector/m",
        query: "component=full",
        requestId: "req-1",
        resourceKey: "/v2/sessions/current/data/field-vector/m?component=full",
        status: 200,
      }),
    ]);
    expect(JSON.stringify(controller.exportArtifact())).not.toContain(
      "secret-body",
    );
  });

  it("bridges fullmag performance diagnostics into structured performance streams", () => {
    const diagnostics = new RequestDiagnosticsController();
    const controller = new DiagnosticRecorderController({
      config: { enabled: true },
      diagnostics,
    });

    diagnostics.record({
      channel: "performance",
      contentType: null,
      detail:
        "performance measure;bucket=viewport-build;source=topology;suppressedSinceLast=0",
      direction: "rx",
      durationMs: 500,
      method: "MEASURE",
      outcome: "ok",
      path: "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
      requestId: "performance-measure",
      status: null,
      timestampMs: 2_000,
    });

    expect(controller.getSnapshot().streams.performance).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({
          bucket: "viewport-build",
          source: "topology",
          suppressedSinceLast: 0,
        }),
        durationMs: 500,
        lane: "viewport-3d",
        name: "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
        severity: "critical",
      }),
    ]);
  });

  it("keeps viewport frame diagnostics in the viewport stream", () => {
    const controller = new DiagnosticRecorderController({
      config: { enabled: true },
    });

    controller.record(
      record({
        durationMs: 1_200,
        kind: "viewport-frame-window",
        lane: "viewport-3d",
        name: "fullmag.viewport3d.frame-window",
        severity: "critical",
      }),
    );

    expect(controller.getSnapshot().streams.viewport3d).toEqual([
      expect.objectContaining({
        lane: "viewport-3d",
        name: "fullmag.viewport3d.frame-window",
      }),
    ]);
    expect(controller.getSnapshot().streams.timeline).toEqual([]);
  });
});

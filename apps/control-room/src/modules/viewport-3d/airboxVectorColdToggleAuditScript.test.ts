import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const auditScript = readFileSync(
  new URL("../../../scripts/audit-airbox-vector-cold-toggle.mjs", import.meta.url),
  "utf8",
);

describe("Airbox vector cold-toggle audit harness", () => {
  it("uses the diagnostic recorder and browser counters instead of unpublished runtime fields", () => {
    expect(auditScript).toContain("enableDiagnosticRecorder: true");
    expect(auditScript).toContain("__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__");
    expect(auditScript).toContain("streams?.viewport3dBuild");
    expect(auditScript).toContain("NOT MEASURED");
    expect(auditScript).not.toContain("runtime?.diagnostics");
    expect(auditScript).not.toContain("runtime?.gpu");
  });

  it("enforces separate wireframe-off and vectors-on phases with a WebGL gate", () => {
    expect(auditScript).toContain('"wireframe-off"');
    expect(auditScript).toContain('"vectors-on"');
    expect(auditScript).toContain("assertWireframeVectorFrame(wireframeOff.state, false, false");
    expect(auditScript).toContain("assertWireframeVectorFrame(vectorOnState, false, true");
    expect(auditScript).toContain("gl.isContextLost()");
    expect(auditScript).toContain("drawingBufferWidth > 0");
  });

  it("requires the canonical three-lane matrix and fails closed for missing lanes", () => {
    expect(auditScript).toContain('"fdm-single-grid"');
    expect(auditScript).toContain('"fdm-multilayer"');
    expect(auditScript).toContain('"fem"');
    expect(auditScript).toContain("CONTROL_ROOM_AUDIT_LANE_URLS");
    expect(auditScript).toContain("CANONICAL_LANE_IDS");
    expect(auditScript).toContain("Missing required audit lane");
  });

  it("qualifies the required stress loops and complete trial metric contract", () => {
    for (const envName of [
      "CONTROL_ROOM_AUDIT_TRIALS",
      "CONTROL_ROOM_AUDIT_RAPID_TOGGLES",
      "CONTROL_ROOM_AUDIT_QUANTITY_SWITCHES",
      "CONTROL_ROOM_AUDIT_SURFACE_TRANSITIONS",
    ]) {
      expect(auditScript).toContain(envName);
    }
    expect(auditScript).toContain("minimumCountEnv");
    expect(auditScript).toContain("runQuantitySwitchAudit");
    expect(auditScript).toContain("targetCount");
    expect(auditScript).toContain("REQUIRED_TRIAL_METRICS");
    expect(auditScript).toContain("assertRequiredTrialMetrics");
    expect(auditScript).toContain("missingMetrics");
    for (const metric of [
      "bytes",
      "requestDurationMs",
      "pointCount",
      "decodeMs",
      "transferMs",
      "workerMs",
      "glyphMs",
      "gpuUploadMs",
      "firstGlyphMs",
      "longTaskCount",
      "longTaskTotalMs",
      "dirtyFrames",
      "drawCalls",
      "heapBytes",
      "webglDrawingBufferPixels",
      "webglHealthy",
      "workers",
      "workerJobs",
      "workerTimers",
      "workerActiveLeases",
      "fallbackCount",
      "fallbackReasons",
    ]) {
      expect(auditScript).toContain(metric);
    }
    expect(auditScript).toContain("p50");
    expect(auditScript).toContain("p95");
    expect(auditScript).toContain("NOT_MEASURED");
  });
});

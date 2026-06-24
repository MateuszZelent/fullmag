import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  join(process.cwd(), "scripts/record-diagnostics.mjs"),
  "utf8",
);

describe("diagnostic recorder script", () => {
  it("accepts the expected recorder environment variables", () => {
    for (const name of [
      "CONTROL_ROOM_URL",
      "CONTROL_ROOM_API_BASE_URL",
      "CONTROL_ROOM_DIAGNOSTICS_SCENARIO",
      "CONTROL_ROOM_DIAGNOSTICS_INTERACTIVE",
      "CONTROL_ROOM_DIAGNOSTICS_HEADLESS",
      "CONTROL_ROOM_DIAGNOSTICS_OUTPUT_DIR",
      "CONTROL_ROOM_DIAGNOSTICS_ALLOW_MISSING_SESSION",
      "CONTROL_ROOM_DIAGNOSTICS_TRACE",
      "CONTROL_ROOM_DIAGNOSTICS_TIMEOUT_MS",
      "CONTROL_ROOM_DIAGNOSTICS_CANVAS_TIMEOUT_MS",
      "CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_OBJECTS",
      "CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_AIRBOX",
      "CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_ORIENTATION_HUD",
      "CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_DIMENSION_FRAME",
      "CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_OVERLAYS",
      "CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_PRIMITIVES",
      "CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_TOPOLOGY_MESH",
      "CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_VECTORS",
      "CONTROL_ROOM_DIAGNOSTICS_DISABLE_3D_FIELD_COLORS",
    ]) {
      expect(script).toContain(name);
    }
  });

  it("can record the 3D scene shell without viewport object layers", () => {
    expect(script).toContain("disable3DObjects");
    expect(script).toContain("disableViewport3DSceneLayers");
    expect(script).toContain("disable3DAirbox");
    expect(script).toContain("disableViewport3DAirboxLayer");
    expect(script).toContain("disable3DOrientationHud");
    expect(script).toContain("disableViewport3DOrientationHud");
    expect(script).toContain("disable3DDimensionFrame");
    expect(script).toContain("disableViewport3DDimensionFrame");
    expect(script).toContain("disable3DOverlays");
    expect(script).toContain("disableViewport3DOverlayLayers");
    expect(script).toContain("disable3DPrimitives");
    expect(script).toContain("disableViewport3DPrimitiveObjectLayer");
    expect(script).toContain("disable3DTopologyMesh");
    expect(script).toContain("disableViewport3DTopologyMeshLayer");
    expect(script).toContain("disable3DVectors");
    expect(script).toContain("disableViewport3DVectorLayers");
    expect(script).toContain("disable3DFieldColors");
    expect(script).toContain("disableViewport3DFieldColorLayers");
  });

  it("enables in-page recorder, CDP metrics, screenshots, and artifact directory output", () => {
    expect(script).toContain("enableDiagnosticRecorder: true");
    expect(script).toContain("Performance.getMetrics");
    expect(script).toContain("Runtime.getHeapUsage");
    expect(script).toContain("screenshots");
    expect(script).toContain("suspect-report.md");
    expect(script).toContain("viewport-3d.ndjson");
    expect(script).toContain("__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__");
  });

  it("writes a lane summary for viewport 3D build-engine records", () => {
    expect(script).toContain("viewport3d-build-summary.json");
    expect(script).toContain("viewport3d-visible-revision-summary.json");
    expect(script).toContain("viewport-3d-build.ndjson");
    expect(script).toContain("viewport-3d-worker-pools.ndjson");
    expect(script).toContain("buildViewport3DBuildSummary");
    expect(script).toContain("buildViewport3DVisibleRevisionSummary");
    expect(script).toContain("fullmag.viewport3d.build-engine.");
    expect(script).toContain("queueWaitMaxMs");
    expect(script).toContain("workerComputeMaxMs");
    expect(script).toContain("fallbackReasons");
  });
});

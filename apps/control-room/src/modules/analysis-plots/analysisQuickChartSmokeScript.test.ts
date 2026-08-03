import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DATA_DOMAIN_META_PATH,
  DATA_TABLES_PATH,
  SESSION_STATUS_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";

const smokeScriptUrl = new URL(
  "../../../scripts/smoke-analysis-quick-chart.mjs",
  import.meta.url,
);

describe("Analysis Quick Chart browser smoke script", () => {
  it("proves Quick Chart coexists with a healthy, unchanged 3D viewport", () => {
    expect(existsSync(smokeScriptUrl)).toBe(true);
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain("installQuickChartDiagnostics");
    expect(smokeScript).toContain("CONTROL_ROOM_ANALYSIS_QUICK_CHART_FIXTURE");
    expect(smokeScript).toContain("installQuickChartFixtureRoutes");
    expect(smokeScript).toContain(
      `url.pathname === "${SESSION_STATUS_PATH}"`,
    );
    expect(smokeScript).toContain(
      `url.pathname === "${VISUALIZATION_STATE_PATH}"`,
    );
    expect(smokeScript).toContain(
      `url.pathname === "${DATA_DOMAIN_META_PATH}"`,
    );
    expect(smokeScript).toContain(
      `url.pathname === "${DATA_TABLES_PATH}"`,
    );
    expect(smokeScript).toContain("allowMissingSessionSmoke: useFixture");
    expect(smokeScript).toContain("disableRealtime: useFixture");
    expect(smokeScript).toContain("snapshotQuickChartAndViewport");
    expect(smokeScript).toContain("assertQuickChartDoesNotMutateViewport");
    expect(smokeScript).toContain("fieldRequests");
    expect(smokeScript).toContain("topologyRequests");
    expect(smokeScript).toContain("visualizationRequests");
    expect(smokeScript).toContain("cameraSignature");
    expect(smokeScript).toContain("dirtyFrames");
    expect(smokeScript).toContain("gpuUploads");
    expect(smokeScript).toContain("unchanged-buffer upload");
    expect(smokeScript).toContain("__FULLMAG_READ_VIEWPORT_3D_DIAGNOSTICS__");
    expect(smokeScript).toContain("__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__");
    expect(smokeScript).toContain("activeInstances");
    expect(smokeScript).toContain("createdInstances");
    expect(smokeScript).toContain("disposedInstances");
    expect(smokeScript).toContain("ResizeObserver");
    expect(smokeScript).toContain("listenerCount");
    expect(smokeScript).toContain("quickListenerTargets.has(this)");
    expect(smokeScript).toContain("animationFrameCount");
    expect(smokeScript).toContain("verifyExactQuickChartValuesAndUnits");
    expect(smokeScript).toContain("0.97982");
    expect(smokeScript).toContain("0.10317");
    expect(smokeScript).toContain("4.447e-6");
    expect(smokeScript).toContain("dimensionless");
    expect(smokeScript).toContain("verifyExactQuickChartRange");
    expect(smokeScript).toContain("captureQuickChartAcceptanceScreenshots");
    expect(smokeScript).toContain("quick-chart-3d-mocha.png");
    expect(smokeScript).toContain("quick-chart-3d-latte.png");
    expect(smokeScript).toContain("quick-chart-3d-zoom-200.png");
    expect(smokeScript).toContain("quick-chart-3d-reduced-motion.png");
    expect(smokeScript).toContain('emulateMedia({ reducedMotion: "reduce" })');
    expect(smokeScript).toContain('document.documentElement.dataset.theme = theme');
    expect(smokeScript).toContain('document.body.style.zoom = "200%"');
    expect(smokeScript).toContain("isContextLost()");
    expect(smokeScript).toContain("drawingBufferWidth");
    expect(smokeScript).toContain("drawingBufferHeight");
    expect(smokeScript).toContain("finalWebGlProof");
    expect(smokeScript).not.toContain("setInterval");
  });
});

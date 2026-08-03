import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SESSION_STATUS_PATH } from "@/kernel/api/apiPaths";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-analysis-plots.mjs",
  import.meta.url,
);

describe("analysis plots smoke script", () => {
  it("is registered and verifies the rendered chart surface", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:analysis-plots"]).toBe(
      "node scripts/smoke-analysis-plots.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    expect(smokeScript).toContain("openAnalysisPlots");
    expect(smokeScript).toContain("verifyAnalysisSurfaceContract");
    expect(smokeScript).toContain("selectPublishedDataset");
    expect(smokeScript).toContain("installAnalysisDatasetFixtureRoutes");
    expect(smokeScript).toContain("analysisStatusFixture");
    expect(smokeScript).toContain(
      `url.pathname === "${SESSION_STATUS_PATH}"`,
    );
    expect(smokeScript).toContain("assertNoVisibleResourceErrors");
    expect(smokeScript).toContain('.fm-notifications__toast[data-kind="error"]');
    expect(smokeScript).toContain('.fm-toast[data-variant="error"]');
    expect(smokeScript).toContain("fulfillMissingFixtureResource");
    expect(smokeScript).not.toContain("fixture resource not published");
    expect(smokeScript).toContain("CONTROL_ROOM_ANALYSIS_PLOTS_FIXTURE");
    expect(smokeScript).toContain("makeRowsFixture");
    expect(smokeScript).toContain("waitForAnalysisRowsAndCanvas");
    expect(smokeScript).toContain("verifyPinnedDatasetProvenance");
    expect(smokeScript).toContain("verifyAnalysisInspectorSummary");
    expect(smokeScript).toContain("verifyLocalSeriesSelection");
    expect(smokeScript).toContain("verifyLocalRangeSelection");
    expect(smokeScript).toContain("verifyNoImplicitLiveRefresh");
    expect(smokeScript).toContain('.getByText(/^Dataset provenance:/)');
    expect(smokeScript).not.toContain('.locator(".fm-analysis-plots__header span")');
    expect(smokeScript).toContain("explicitDatasetRequestBaseline");
    expect(smokeScript).toContain("ANALYSIS_LIVE_REFRESH_OBSERVE_MS");
    expect(smokeScript).toContain("captureAnalysisAcceptanceScreenshots");
    expect(smokeScript).toContain("analysis-mocha.png");
    expect(smokeScript).toContain("analysis-latte.png");
    expect(smokeScript).toContain("analysis-zoom-200.png");
    expect(smokeScript).toContain("analysis-reduced-motion.png");
    expect(smokeScript).toContain('emulateMedia({ reducedMotion: "reduce" })');
    expect(smokeScript).toContain('document.documentElement.dataset.theme = theme');
    expect(smokeScript).toContain('document.body.style.zoom = "200%"');
    expect(smokeScript).toContain("analysisPlotRequests");
    expect(smokeScript).toContain("resourceFamilyCounts");
    expect(smokeScript).toContain("verifySeriesLegend");
    expect(smokeScript).toContain("verifyPointSelection");
    expect(smokeScript).toContain("dispatchPointClick");
    expect(smokeScript).toContain("dispatchDataZoom");
    expect(smokeScript).toContain("collectAnalysisPlotProof");
    expect(smokeScript).toContain("ECharts canvas appears blank");
    expect(smokeScript).toContain("analysis series legend is missing");
    expect(smokeScript).toContain("rows.bin requests after local series selection");
    expect(smokeScript).toContain("rows.bin requests after local range selection");
    expect(smokeScript).toContain("rows.bin request budget exceeded");
    expect(smokeScript).toContain("CONTROL_ROOM_ANALYSIS_PLOTS_MAX_ROWS_BIN_REQUESTS");
    expect(smokeScript).toContain('"Dynamics", "Spectrum", "Frequency Response", "Eigenmodes", "Dispersion", "Hysteresis", "Comparison"');
    expect(smokeScript).not.toContain("verifyAxisControlInteraction");
    expect(smokeScript).not.toContain("verifyThirdUnitSelectionDisabled");
    expect(smokeScript).not.toContain("verifyAtLeastOneYAxisRemainsSelected");
    expect(smokeScript).not.toContain("fm-analysis-plots__column-row");
    expect(smokeScript).not.toContain("fm-analysis-plots__range-clear");
    expect(smokeScript).not.toContain("Chart range");
    expect(smokeScript).not.toContain("Last 160 points");
    expect(smokeScript).not.toContain("setInterval");
  });
});

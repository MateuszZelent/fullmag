import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MODEL_READINESS_PATH,
  MODEL_UNIVERSE_PATH,
  PLATFORM_DEVELOPMENT_BACKEND_PATH,
  SESSIONS_PATH,
  SESSION_STATUS_PATH,
  VISUALIZATION_MODE_COMPOSITION_ACTIVE_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-analysis-plots.mjs",
  import.meta.url,
);
const viewportSmokeScriptUrl = new URL(
  "../../../scripts/smoke-viewport-3d-explorer-inspector-targets.mjs",
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
      `const SESSION_COLLECTION_PATH = "${SESSIONS_PATH}";`,
    );
    expect(smokeScript).toContain("function sessionCollectionFixture()");
    expect(smokeScript).toContain("session_id: FIXTURE_SESSION_ID");
    expect(smokeScript).toContain("url.pathname !== SESSION_COLLECTION_PATH");
    expect(smokeScript).toContain(`const DEVELOPMENT_BACKEND_FIXTURE_PATH = "${PLATFORM_DEVELOPMENT_BACKEND_PATH}";`);
    expect(smokeScript).toContain('url.pathname !== DEVELOPMENT_BACKEND_FIXTURE_PATH');
    expect(smokeScript).toContain('"access-control-allow-methods": "GET, OPTIONS"');
    expect(smokeScript).toContain('state: "disabled"');
    expect(smokeScript).toContain("configured: false");
    expect(smokeScript).toContain("current: true");
    expect(smokeScript).toContain("session_epoch: FIXTURE_SESSION_EPOCH");
    expect(smokeScript).toContain(
      "request_scope_epoch: FIXTURE_REQUEST_SCOPE_EPOCH",
    );
    expect(smokeScript).toContain('schema_version: "eigen_spectrum.v2"');
    expect(smokeScript).toContain("residual_norm: 2e-4");
    expect(smokeScript).toContain("residual_relative_l2: 1e-7");
    expect(smokeScript).toContain('"Relative residual (L2)": 1e-7');
    expect(smokeScript).toContain('"Spectrum residual (type unspecified)": 2e-4');
    expect(smokeScript).toContain("waitForFrequencyDomainResidualFields");
    expect(smokeScript).toContain("expectModeDetailRelativeL2Absent: true");
    expect(smokeScript).toContain("modeDetailCanonicalRelativeL2Present");
    expect(smokeScript).toContain("page.waitForResponse(");
    expect(smokeScript).toContain("waitForFrequencyDomainTooltip");
    expect(smokeScript).toContain('tooltipTerms: ["mode index: 1", "Eigen frequency", "2.25 GHz"]');
    expect(smokeScript).toContain("fm-chart-tooltip");
    expect(smokeScript).toContain("tooltip-failure.png");
    expect(smokeScript).toContain('scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" })');
    expect(smokeScript).toContain("document.elementFromPoint(target.x, target.y)");
    expect(smokeScript).toContain("insideFooter: pointerTarget !== null && footer?.contains(pointerTarget) === true");
    expect(smokeScript).toContain('schemaVersion: "frequency_domain_eigen_spectrum.v1"');
    expect(smokeScript).toContain('schemaVersion: "frequency_domain_eigen_mode_resource.v1"');
    expect(smokeScript).toContain('schema_version: "eigen_mode.v2"');
    expect(smokeScript).toContain('frequency_domain_response_sweep_resource.v1');
    expect(smokeScript).toContain('eigen/modes/sample_${String(expectedSelection.sampleIndex).padStart(4, "0")}/mode_${String(expectedSelection.modeIndex).padStart(4, "0")}.json');
    expect(smokeScript).toContain(
      `url.pathname === "${SESSION_STATUS_PATH}"`,
    );
    expect(smokeScript).toContain(`url.pathname === "${VISUALIZATION_STATE_PATH}"`);
    expect(smokeScript).toContain(`url.pathname === "${VISUALIZATION_MODE_COMPOSITION_ACTIVE_PATH}"`);
    expect(smokeScript).toContain(`url.pathname === "${MODEL_UNIVERSE_PATH}"`);
    expect(smokeScript).toContain(`url.pathname === "${MODEL_READINESS_PATH}"`);
    expect(smokeScript).toContain("ready_to_run: false");
    expect(smokeScript).toContain("function analysisVisualizationStateFixture()");
    expect(smokeScript).toContain("function analysisModeCompositionFixture(frequencyDomainPublished)");
    expect(smokeScript).toContain('schema_version: "mode-composition.v1"');
    expect(smokeScript).toContain("schema_version: 5");
    expect(smokeScript).toContain("scene_revision: 0");
    expect(smokeScript).toContain("assertNoVisibleResourceErrors");
    expect(smokeScript).toContain('.fm-notifications__toast[data-kind="error"]');
    expect(smokeScript).toContain('.fm-toast[data-variant="error"]');
    expect(smokeScript).toContain("fulfillMissingFixtureResource");
    expect(smokeScript).not.toContain("fixture resource not published");
    expect(smokeScript).not.toContain("allowMissingSessionSmoke");
    expect(smokeScript).toContain("disableRealtime");
    expect(smokeScript).toContain("CONTROL_ROOM_ANALYSIS_PLOTS_FIXTURE");
    expect(smokeScript).toContain("makeRowsFixture");
    expect(smokeScript).toContain("waitForAnalysisRowsAndCanvas");
    expect(smokeScript).toContain("verifyPinnedDatasetProvenance");
    expect(smokeScript).toContain("verifyAnalysisInspectorSummary");
    expect(smokeScript).toContain("verifyLocalSeriesSelection");
    expect(smokeScript).toContain("verifyLocalRangeSelection");
    expect(smokeScript).toContain("verifyResponsiveAnalysisFixtures");
    expect(smokeScript).toContain("verifyReducedMotionAndKeyboardControls");
    expect(smokeScript).toContain("[360, 640, 900, 1280]");
    expect(smokeScript).toContain("document.documentElement.scrollWidth <= window.innerWidth + 1");
    expect(smokeScript).toContain("X axis");
    expect(smokeScript).toContain("Y axes");
    expect(smokeScript).toContain("Select .+ row \\d+");
    expect(smokeScript).toContain('data-status") === "refreshing"');
    expect(smokeScript).toContain("Enter");
    expect(smokeScript).toContain("Space");
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
    expect(smokeScript).toContain("inspectFrequencyChartOption");
    expect(smokeScript).toContain("readRenderedOption");
    expect(smokeScript).toContain("resolveRenderedDataPoint");
    const zoomHelperStart = smokeScript.indexOf("async function zoomFrequencyDomainPoint(");
    const zoomHelperEnd = smokeScript.indexOf(
      "\nasync function clickFrequencyDomainPoint(",
      zoomHelperStart,
    );
    expect(zoomHelperStart).toBeGreaterThanOrEqual(0);
    expect(zoomHelperEnd).toBeGreaterThan(zoomHelperStart);
    const zoomHelper = smokeScript.slice(zoomHelperStart, zoomHelperEnd);
    expect(zoomHelper).toContain('await page.keyboard.down("Control")');
    expect(zoomHelper).toContain("await page.mouse.wheel(0, wheelDeltaY)");
    expect(zoomHelper).toContain("inspectFrequencyChartOption(page, fixture)");
    expect(zoomHelper).toContain("inspectFrequencyDomainPointSpacing(page, expected)");
    expect(zoomHelper).toContain("nearestCompetitorDistancePx");
    expect(zoomHelper).not.toContain("dispatchAction");
    expect(smokeScript).toContain("zoomEvidence");
    expect(smokeScript).toContain("analysis-frequency-domain-fixture-proof.json");
    expect(smokeScript).toMatch(/proofs\.push\(proof\);\s*persistFixtureProof\(false\);/);
    expect(smokeScript).toContain("persistFixtureProof(true)");
    expect(smokeScript).toContain("lastRenderedClick");
    expect(smokeScript).toContain("mode-click-failure.json");
    expect(smokeScript).toContain("appliedTarget");
    expect(smokeScript).toContain("requestSeen: Boolean(request)");
    expect(smokeScript).toContain("priorRenderedClick");
    expect(smokeScript).toContain("targetCoordinate: coordinateTarget");
    expect(smokeScript).toContain("JSON.stringify({ ...failureEvidence, screenshot }, null, 2)");
    expect(smokeScript).toContain("requireDispersionRenderEvidence");
    expect(smokeScript).toContain("nonNullPointCount !== 5_000");
    expect(smokeScript).toContain('line.symbolFill !== "transparent"');
    expect(smokeScript).toContain("line.symbolSize !== 2");
    expect(smokeScript).toContain("scatter.symbolSize !== 4");
    expect(smokeScript).toContain('entry.type === "scatter"');
    expect(smokeScript).toContain("targetPreviousIsNullSentinel");
    expect(smokeScript).toContain("line.connectNulls !== false");
    expect(smokeScript).toContain("clickDataIndex !== renderedClick.targetDataIndex");
    expect(smokeScript).toContain("collectAnalysisPlotProof");
    expect(smokeScript).toContain("ECharts canvas appears blank");
    expect(smokeScript).toContain("analysis series legend is missing");
    expect(smokeScript).toContain("rows.bin requests after local series selection");
    expect(smokeScript).toContain("rows.bin requests after local range selection");
    expect(smokeScript).toContain("rows.bin request budget exceeded");
    expect(smokeScript).toContain("CONTROL_ROOM_ANALYSIS_PLOTS_MAX_ROWS_BIN_REQUESTS");
    expect(smokeScript).not.toContain("verifyAxisControlInteraction");
    expect(smokeScript).not.toContain("verifyThirdUnitSelectionDisabled");
    expect(smokeScript).not.toContain("verifyAtLeastOneYAxisRemainsSelected");
    expect(smokeScript).not.toContain("fm-analysis-plots__column-row");
    expect(smokeScript).not.toContain("fm-analysis-plots__range-clear");
    expect(smokeScript).not.toContain("Chart range");
    expect(smokeScript).not.toContain("Last 160 points");
    expect(smokeScript).not.toContain("setInterval");

    const viewportSmokeScript = readFileSync(viewportSmokeScriptUrl, "utf8");
    expect(viewportSmokeScript).toContain("verifyAnalysisViewportHandoff");
    expect(viewportSmokeScript).toContain('targetSmokePhase === "analysis-handoff"');
    expect(viewportSmokeScript).toContain("Frequency Response");
    expect(viewportSmokeScript).toContain("Eigenmodes");
    expect(viewportSmokeScript).toContain("Dispersion");
    expect(viewportSmokeScript).toContain("selectAnalysisSurfaceFromExplorer");
    expect(viewportSmokeScript).toContain('getAttribute("data-analysis-surface-title") === surfaceId');
    expect(viewportSmokeScript).toContain(".fm-chart-section, .fm-analysis-plots__empty, [role='status']");
    expect(viewportSmokeScript).toContain("assertHealthyCanvas");
    expect(viewportSmokeScript).toContain("isContextLost()");
    expect(viewportSmokeScript).toContain("drawingBufferWidth");
    expect(viewportSmokeScript).toContain("drawingBufferHeight");
  });
});

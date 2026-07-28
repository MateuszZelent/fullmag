import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(smokeScript).toContain("waitForAnalysisRowsAndCanvas");
    expect(smokeScript).toContain("verifyAxisControlInteraction");
    expect(smokeScript).toContain("verifyThirdUnitSelectionDisabled");
    expect(smokeScript).toContain("verifyAtLeastOneYAxisRemainsSelected");
    expect(smokeScript).toContain("verifyZoomRangeFetch");
    expect(smokeScript).toContain("rangeSelectedEvents");
    expect(smokeScript).toContain("seriesSelectedEvents");
    expect(smokeScript).toContain("verifySeriesLegend");
    expect(smokeScript).toContain("verifySeriesSelectionEvent");
    expect(smokeScript).toContain("verifyPointSelection");
    expect(smokeScript).toContain("verifyAddSeriesEvent");
    expect(smokeScript).toContain("dispatchPointClick");
    expect(smokeScript).toContain("dispatchSeriesRequest");
    expect(smokeScript).toContain("collectAnalysisPlotProof");
    expect(smokeScript).toContain("ECharts canvas appears blank");
    expect(smokeScript).toContain("analysis series legend is missing");
    expect(smokeScript).toContain("rows.bin requests after axis interaction");
    expect(smokeScript).toContain("third-unit Y-axis checkbox remained enabled");
    expect(smokeScript).toContain("rows.bin requests after Y-axis toggle");
    expect(smokeScript).toContain("zoom rows.bin request did not include a visible range");
    expect(smokeScript).toContain("chart range-selected event was not emitted for zoom");
    expect(smokeScript).toContain("chart range-selected clear event was not emitted");
    expect(smokeScript).toContain("chart series-selected event was not emitted");
    expect(smokeScript).toContain("rows.bin requests after series selection");
    expect(smokeScript).toContain("rows.bin request budget exceeded");
    expect(smokeScript).toContain("CONTROL_ROOM_ANALYSIS_PLOTS_MAX_ROWS_BIN_REQUESTS");
    expect(smokeScript).not.toContain("hasText: /^ts$/");
    expect(smokeScript).toContain("const targetIndex = await xAxisRadios.first().isChecked() ? 1 : 0");
    expect(smokeScript).toContain("root?.querySelectorAll");
    expect(smokeScript).not.toContain("setInterval");
  });
});

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const auditScriptUrl = new URL(
  "../../../scripts/audit-chart-performance.mjs",
  import.meta.url,
);
const computeAuditScriptUrl = new URL(
  "../../../scripts/audit-compute-performance.mjs",
  import.meta.url,
);
const chartSurfaceUrl = new URL(
  "./components/EChartsSurface.tsx",
  import.meta.url,
);
const chartDiagnosticsUrl = new URL(
  "./components/chartDiagnostics.ts",
  import.meta.url,
);

describe("analysis plots performance audit", () => {
  it("audits the dataset-driven Analysis resource ownership and bounded table projection", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["audit:compute-performance"]).toBe(
      "node scripts/audit-compute-performance.mjs",
    );
    expect(existsSync(computeAuditScriptUrl)).toBe(true);

    const auditScript = readFileSync(computeAuditScriptUrl, "utf8");
    expect(auditScript).toContain("fileURLToPath(import.meta.url)");
    expect(auditScript).toContain('path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")');
    expect(auditScript).toContain("useAnalysisDatasetData.ts");
    expect(auditScript).toContain("analysis plots dataset resource owner");
    expect(auditScript).toContain('activeSurface === "dynamics" || activeSurface === "comparison"');
    expect(auditScript).toContain('activeSurface === "frequency-response" || activeSurface === "eigenmodes"');
    expect(auditScript).toContain('useSpinWaveGammaResource(activeSurface === "spectrum")');
    expect(auditScript).toContain('useDynamicStructureFactorResource(activeSurface === "dispersion")');
    expect(auditScript).toContain("targetPoints: 1_600");
    expect(auditScript).toContain("limit: 5_000");
    expect(auditScript).toContain("enabled: enabled && !pinnedForDataset");
    expect(auditScript).toContain("setPinned({ datasetRef, revision: decodedTable.revision, table: decodedTable })");
    expect(auditScript).not.toContain("useAnalysisTableData.ts");
    expect(auditScript).not.toContain("useAnalysisEnergyData.ts");
  });

  it("is registered and verifies chart idle and lifecycle budgets", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["audit:chart-performance"]).toBe(
      "node scripts/audit-chart-performance.mjs",
    );
    expect(existsSync(auditScriptUrl)).toBe(true);

    const auditScript = readFileSync(auditScriptUrl, "utf8");
    expect(auditScript).toContain("assertChartPerformanceProof");
    expect(auditScript).toContain("ChartPerformanceProof");
    expect(auditScript).toContain("phase: \"cold\"");
    expect(auditScript).toContain("phase: \"warm\"");
    expect(auditScript).toContain("payloadBytes");
    expect(auditScript).toContain("cacheHits");
    expect(auditScript).toContain("cacheMisses");
    expect(auditScript).toContain("modelBuilds");
    expect(auditScript).toContain("plannedPoints");
    expect(auditScript).toContain("listeners");
    expect(auditScript).toContain("observers");
    expect(auditScript).toContain("workers");
    expect(auditScript).toContain("baselineHeapBytes");
    expect(auditScript).toContain("retainedHeapBytes");
    expect(auditScript).toContain("contextLost");
    expect(auditScript).toContain("drawingBufferWidth");
    expect(auditScript).toContain("adoptedAfterAbort");
    expect(auditScript).toContain("writeFile");
    expect(auditScript).toContain("__FULLMAG_ENABLE_CHART_DIAGNOSTICS__");
    expect(auditScript).toContain("collectChartDiagnostics");
    expect(auditScript).toContain("collectChartSurfaceCount");
    expect(auditScript).toContain("verifyIdleChartBudget");
    expect(auditScript).toContain("pauseAnalysisUpdates(page)");
    expect(auditScript).toContain("Resume live chart updates");
    expect(auditScript).toContain("verifyChartInstanceLifecycle");
    expect(auditScript).toContain("waitForQuietRowsBinRequests");
    expect(auditScript).toContain("waitForRowsTransportSizes");
    expect(auditScript).toContain('page.on("requestfinished"');
    expect(auditScript).toContain("discardCancelledRowsBinRequest");
    expect(auditScript).toContain("summarizeRowsBinRequests");
    expect(auditScript).toContain("rows.bin requests during chart idle");
    expect(auditScript).toContain("chart redraws during idle");
    expect(auditScript).toContain("chart instance leak");
    expect(auditScript).not.toContain("activeInstances === 1");
    expect(auditScript).not.toContain("setInterval");
  });

  it("keeps ECharts diagnostics opt-in and bounded", () => {
    const source = readFileSync(chartSurfaceUrl, "utf8");
    const diagnosticsSource = readFileSync(chartDiagnosticsUrl, "utf8");

    expect(source).toContain("recordChartInstanceCreated");
    expect(source).toContain("recordChartInstanceDisposed");
    expect(source).toContain("recordChartSetOption");
    expect(source).not.toContain("setInterval");
    expect(diagnosticsSource).toContain("__FULLMAG_ENABLE_CHART_DIAGNOSTICS__");
    expect(diagnosticsSource).toContain("__FULLMAG_CHART_DIAGNOSTICS__");
    expect(diagnosticsSource).not.toContain("setInterval");
  });
});

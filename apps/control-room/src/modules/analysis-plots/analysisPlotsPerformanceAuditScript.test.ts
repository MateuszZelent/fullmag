import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SESSION_STATUS_PATH,
  SIMULATION_PREPARATION_PATH,
} from "@/kernel/api/apiPaths";

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
    expect(auditScript).toContain("resolveBuildProvenance");
    expect(auditScript).toContain("diffFingerprint");
    expect(auditScript).toContain("--porcelain=v1");
    expect(auditScript).toContain('"--show-toplevel"');
    expect(auditScript).toContain("same-runtime remount");
    expect(auditScript).toContain("alternateDatasetRef");
    expect(auditScript).toContain("selectExplicitAnalysisDataset(page, 1)");
    expect(auditScript).not.toContain("page.reload");
    expect(auditScript).toContain('?? "unknown"');
    expect(auditScript).toContain("CONTROL_ROOM_AUDIT_COMMIT");
    expect(auditScript).toContain("does not match current HEAD");
    expect(auditScript).toContain('cacheMeasurement: "NOT_MEASURED"');
    expect(auditScript).toContain("cacheHits: null");
    expect(auditScript).toContain("cacheMisses: null");
    expect(auditScript).toContain("writeFile");
    expect(auditScript).toContain("__FULLMAG_ENABLE_CHART_DIAGNOSTICS__");
    expect(auditScript).toContain("collectChartDiagnostics");
    expect(auditScript).toContain("collectChartSurfaceCount");
    expect(auditScript).toContain("verifyIdleChartBudget");
    expect(auditScript).toContain("pauseAnalysisUpdates(page)");
    expect(auditScript).toContain("Resume live chart updates");
    expect(auditScript).toContain("verifyChartInstanceLifecycle");
    expect(auditScript).toContain("selectDynamicsAnalysisSurface");
    expect(auditScript).toContain("waitForAnimationFrameOwnershipStable");
    expect(auditScript).not.toContain("result.animationFrameCallbacks > 0");
    expect(auditScript).toContain("round < 3");
    expect(auditScript).toContain("waitForQuietRowsBinRequests");
    expect(auditScript).toContain("waitForRowsTransportSizes");
    expect(auditScript).toContain('page.on("requestfinished"');
    expect(auditScript).toContain("discardCancelledRowsBinRequest");
    expect(auditScript).toContain("summarizeRowsBinRequests");
    expect(auditScript).toContain("rows.bin requests during chart idle");
    expect(auditScript).toContain("chart redraws during idle");
    expect(auditScript).toContain("chart instance leak");
    expect(auditScript).toContain("createdObjectUrls");
    expect(auditScript).toContain("revokedObjectUrls");
    expect(auditScript).toContain("activeAnimationFrames");
    expect(auditScript).not.toContain("activeInstances === 1");
    expect(auditScript).not.toContain("setInterval");
  });

  it("stress-tests Quick Chart beside 3D with measured lifecycle and isolation budgets", () => {
    const auditScript = readFileSync(auditScriptUrl, "utf8");

    expect(auditScript).toContain("CONTROL_ROOM_CHART_PERFORMANCE_TAB_SWITCHES");
    expect(auditScript).toContain("100");
    expect(auditScript).toContain("verifyQuickChartViewportIsolation");
    expect(auditScript).toContain("verifyLocalQuickChartActionBudget");
    expect(auditScript).toContain("collectViewport3DIsolationSnapshot");
    expect(auditScript).toContain("collectLifecycleSnapshot");
    expect(auditScript).toContain("unobserve(target)");
    expect(auditScript).toContain("__fullmagAuditTargets");
    expect(auditScript).toContain("__fullmagAuditListenerRegistry");
    expect(auditScript).toContain("sweepActiveListeners");
    expect(auditScript).toContain("normalizeListenerCapture");
    expect(auditScript).toContain("options?.once");
    expect(auditScript).toContain("options?.signal");
    expect(auditScript).toContain("analysisLifecycleBaseline");
    expect(auditScript).toContain("analysisLifecycleAfterClose");
    expect(auditScript).toContain("latestRevision");
    expect(auditScript).toContain("staleValuesAdopted");
    expect(auditScript).toContain("forceGarbageCollection");
    expect(auditScript).toContain("objectUrls");
    expect(auditScript).toContain("animationFrames");
    expect(auditScript).toContain("mutationObservers");
    expect(auditScript).toContain("resizeObservers");
    expect(auditScript).toContain("intervals");
    expect(auditScript).toContain("maxRetainedHeapGrowthBytes");
    expect(auditScript).toContain("quick-chart-open-close");
    expect(auditScript).toContain("Quick Chart cursor");
    expect(auditScript).toContain("fieldRequests");
    expect(auditScript).toContain("topologyRequests");
    expect(auditScript).toContain("cameraChanges");
    expect(auditScript).toContain("unchangedBufferUploads");
    expect(auditScript).toContain("dirtyFrames");
    expect(auditScript).toContain("contextLost");
    expect(auditScript).toContain("drawingBufferWidth");
    expect(auditScript).toContain("drawingBufferHeight");
    expect(auditScript).toContain("Quick Chart + 3D isolation failed");
    expect(auditScript).not.toContain("dirtyFrames: 0,");
    expect(auditScript).not.toContain("fieldRequests: 0,");
    expect(auditScript).not.toContain("topologyRequests: 0,");
    expect(auditScript).not.toContain("unchangedBufferUploads: 0,");
  });

  it("provides a complete fixture session without bypassing preparation", () => {
    const auditScript = readFileSync(auditScriptUrl, "utf8");

    expect(auditScript).toContain("installChartPerformanceFixtureRoutes");
    expect(auditScript).toContain(
      `requestUrl.pathname === "${SESSION_STATUS_PATH}"`,
    );
    expect(auditScript).toContain(
      `requestUrl.pathname === "${SIMULATION_PREPARATION_PATH}"`,
    );
    expect(auditScript).toContain("simulation_preparation_revision: 0");
    expect(auditScript).toContain('state: "awaiting_command"');
    expect(auditScript).toContain("selectExplicitAnalysisDataset");
    expect(auditScript).toContain('name: "Analysis dataset"');
    expect(auditScript).toContain("disableRealtime: fixtureMode");
    expect(auditScript).toContain("summarizeFailedResponses");
    expect(auditScript).toContain("isExpectedFixtureFailure");
    expect(auditScript).toContain("unexpectedFailedResponses");
    expect(auditScript).toContain("Unexpected fixture resource failures");
    expect(auditScript).toContain("expectedFixtureFailures");
    expect(auditScript).not.toContain("allowMissingSessionSmoke");
    expect(auditScript).not.toContain("hideStartupOverlay");
    expect(auditScript).toContain("buffer.writeBigUInt64LE(BigInt(revision), 8)");
    expect(auditScript).toContain("buffer.writeBigUInt64LE(1n, 16)");
    expect(auditScript).toContain("buffer.writeBigUInt64LE(BigInt(totalRows), 40)");
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

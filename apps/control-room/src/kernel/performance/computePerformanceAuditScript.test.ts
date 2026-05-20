import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const auditScriptUrl = new URL(
  "../../../scripts/audit-compute-performance.mjs",
  import.meta.url,
);

describe("compute performance audit script", () => {
  it("is exposed as a package script and guards compute-specific invalidation fanout", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["audit:compute-performance"]).toBe(
      "node scripts/audit-compute-performance.mjs",
    );
    expect(existsSync(auditScriptUrl)).toBe(true);

    const auditScript = readFileSync(auditScriptUrl, "utf8");
    expect(auditScript).toContain("checkComputeCommandInvalidationScope");
    expect(auditScript).toContain("checkRealtimeSessionStatusFanout");
    expect(auditScript).toContain("checkBinaryDecodeScheduler");
    expect(auditScript).toContain("checkSessionStatusSelectors");
    expect(auditScript).toContain("checkViewportPerformanceMarks");
    expect(auditScript).toContain("binaryDecodeWorker");
    expect(auditScript).toContain("binaryDecodePayload");
    expect(auditScript).toContain('from "./binaryDecodeScheduler"');
    expect(auditScript).toContain("study.compute-fields");
    expect(auditScript).toContain("study.compute-energies");
    expect(auditScript).toContain("SESSION_STATUS_RECOMMENDED_FETCHES");
    expect(auditScript).toContain("useSessionStatusSelector");
    expect(auditScript).toContain("fullmag.viewport3d.buildTopologyRenderModel");
    expect(auditScript).toContain("fullmag.api.requestBinaryResource.topology");
    expect(auditScript).toContain("fullmag.viewport3d.buildFdmCuboidInstanceModel");
    expect(auditScript).toContain("checkFdmCuboidChunkedUpload");
    expect(auditScript).toContain("buildFdmCuboidUploadBatches");
    expect(auditScript).toContain("checkFooterTelemetryIsOptIn");
    expect(auditScript).toContain('useState<FooterTabId>("logs")');
    expect(auditScript).toContain("checkViewportSmokeComputeMetrics");
    expect(auditScript).toContain("checkComputePerformanceSmokeScript");
    expect(auditScript).toContain("smoke-compute-performance.mjs");
    expect(auditScript).toContain("checkShellSelectorHooks");
    expect(auditScript).toContain("checkCommandShortcutConnector");
    expect(auditScript).toContain("checkFooterDiagnosticsBatching");
    expect(auditScript).toContain("checkPerformanceDiagnosticsExport");
    expect(auditScript).toContain("startPerformanceMeasureDiagnostics");
    expect(auditScript).toContain("channel: \"performance\"");
    expect(auditScript).toContain("checkVisualizationPatchHotPath");
    expect(auditScript).toContain("checkReactRenderProfilerInstrumentation");
    expect(auditScript).toContain("WorkspaceRenderProfiler");
    expect(auditScript).toContain("fullmag.react.render.RibbonModule");
    expect(auditScript).toContain("VisualizationRegistrySyncController.queuePatch");
    expect(auditScript).toContain("visualizationPatchSatisfiesPatch");
    expect(auditScript).toContain("ObjectVisualizationController.samePatch");
    expect(auditScript).toContain("Object.is");
    expect(auditScript).toContain("installComputePerformanceProbe");
    expect(auditScript).toContain("collectComputePerformanceProbe");
    expect(auditScript).toContain("useLayoutSelector");
    expect(auditScript).toContain("useSelectionSelector");
    expect(auditScript).toContain("runtimeResourceDataRef.current");
    expect(auditScript).toContain("listNewestFirst");
    expect(auditScript).toContain("queueMicrotask");
    expect(auditScript).toContain('"longtask"');
  });
});

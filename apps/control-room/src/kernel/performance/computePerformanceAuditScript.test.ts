import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DATA_SCALARS_PATH,
  SIMULATION_SOLVER_ENERGIES_CURRENT_PATH,
  SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
} from "../api/apiPaths";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const auditScriptUrl = new URL(
  "../../../scripts/audit-compute-performance.mjs",
  import.meta.url,
);
const appRootUrl = new URL("../../..", import.meta.url);

describe("compute performance audit script", () => {
  it("executes successfully so syntax errors fail the test suite", () => {
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(auditScriptUrl)],
      { cwd: fileURLToPath(appRootUrl), encoding: "utf8" },
    );

    expect(output).toContain("Compute performance audit passed.");
  });

  it("is exposed as a package script and guards compute-specific invalidation fanout", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["audit:compute-performance"]).toBe(
      "node scripts/audit-compute-performance.mjs",
    );
    expect(packageJson.scripts?.["bench:compute-performance"]).toBe(
      "vitest run src/kernel/performance/computePerformanceMicrobench.test.ts --pool=threads",
    );
    expect(existsSync(auditScriptUrl)).toBe(true);

    const auditScript = readFileSync(auditScriptUrl, "utf8");
    expect(auditScript).toContain("checkComputeCommandInvalidationScope");
    expect(auditScript).toContain("checkStudyRunCommandInvalidationScope");
    expect(auditScript).toContain("study.run");
    expect(auditScript).toContain("submitRuntimeCommand");
    expect(auditScript).toContain("checkRealtimeSessionStatusFanout");
    expect(auditScript).toContain("checkBinaryDecodeScheduler");
    expect(auditScript).toContain("checkSessionStatusSelectors");
    expect(auditScript).toContain("checkExplorerModuleSessionStatusSelector");
    expect(auditScript).toContain("selectExplorerModelRuntimeStatus");
    expect(auditScript).toContain("explorerModelRuntimeStatusEquals");
    expect(auditScript).toContain("checkRibbonModuleSessionStatusSelector");
    expect(auditScript).toContain("selectRibbonRuntimeStatus");
    expect(auditScript).toContain("ribbonRuntimeStatusEquals");
    expect(auditScript).toContain("checkViewportPerformanceMarks");
    expect(auditScript).toContain("binaryDecodeWorker");
    expect(auditScript).toContain("binaryDecodePayload");
    expect(auditScript).toContain('from "./binaryDecodeScheduler"');
    expect(auditScript).toContain("study.compute-fields");
    expect(auditScript).toContain("study.compute-energies");
    expect(auditScript).toContain("SESSION_STATUS_RECOMMENDED_FETCHES");
    expect(auditScript).toContain("useSessionStatusSelector");
    expect(auditScript).toContain("checkHeaderSessionStatusSelector");
    expect(auditScript).toContain("selectHeaderSessionSource");
    expect(auditScript).toContain("headerSessionSourceEquals");
    expect(auditScript).toContain("checkRuntimeControlSessionStatusSelector");
    expect(auditScript).toContain("checkSimulationStartupOverlaySessionStatusSelector");
    expect(auditScript).toContain("selectSimulationStartupOverlayResourceState");
    expect(auditScript).toContain("simulationStartupOverlayResourceStateEquals");
    expect(auditScript).toContain("selectRuntimeCommandControlSessionStatus");
    expect(auditScript).toContain("runtimeCommandControlSessionStatusEquals");
    expect(auditScript).toContain("previous.run?.run_id !== next.run?.run_id");
    expect(auditScript).toContain(
      "checkStudyRuntimeCommandResourceDataSessionStatusSelector",
    );
    expect(auditScript).toContain("selectStudyRuntimeCommandSessionStatus");
    expect(auditScript).toContain("studyRuntimeCommandSessionStatusEquals");
    expect(auditScript).toContain("session status narrow revision");
    expect(auditScript).toContain("SESSION_STATUS_REVISION_RESOURCE_KEYS");
    expect(auditScript).toContain("Object.values(status.resources)");
    expect(auditScript).toContain("checkFieldCatalogResourceSeparation");
    expect(auditScript).toContain("checkObjectVisualizationPanelSessionStatusSelector");
    expect(auditScript).toContain("checkObjectVisualizationPanelVisualizationSelector");
    expect(auditScript).toContain("checkObjectVisualizationPanelNumberFieldCommitBoundary");
    expect(auditScript).toContain("pendingValueRef");
    expect(auditScript).toContain("setDraftOverride(nextValue)");
    expect(auditScript).not.toContain("VISUALIZATION_NUMBER_COMMIT_DELAY_MS");
    expect(auditScript).toContain("Wireframe opacity");
    expect(auditScript).toContain("Vector alpha");
    expect(auditScript).toContain("Vector thickness");
    expect(auditScript).toContain("Arrow length");
    expect(auditScript).toContain("Arrow budget");
    expect(auditScript).toContain("Extra surface gap");
    expect(auditScript).toContain("label=\"Opacity\"");
    expect(auditScript).toContain('patchNumber("vectorBudget"');
    expect(auditScript).toContain('patchNumber("vectorThickness"');
    expect(auditScript).toContain('patchNumber("vectorLengthScale"');
    expect(auditScript).toContain("onPointerUp={flushDraft}");
    expect(auditScript).toContain("onPointerCancel={flushDraft}");
    expect(auditScript).toContain("onKeyUp={flushDraft}");
    expect(auditScript).toContain("onBlur={flushDraft}");
    expect(auditScript).toContain("selectObjectVisualizationPanelSnapshot");
    expect(auditScript).toContain("objectVisualizationPanelSnapshotEquals");
    expect(auditScript).toContain("checkMeshDetailsPanelSessionStatusSelector");
    expect(auditScript).toContain("selectMeshDetailsRuntimeStatus");
    expect(auditScript).toContain("meshDetailsRuntimeStatusEquals");
    expect(auditScript).toContain("checkAirboxMeshPolicyPanelSessionStatusSelector");
    expect(auditScript).toContain("selectAirboxMeshPolicyRuntimeStatus");
    expect(auditScript).toContain("airboxMeshPolicyRuntimeStatusEquals");
    expect(auditScript).toContain("checkStudyInspectorPanelSessionStatusSelector");
    expect(auditScript).toContain("selectStudyInspectorRuntimeStatus");
    expect(auditScript).toContain("studyInspectorRuntimeStatusEquals");
    expect(auditScript).toContain("checkMeshBuildDialogSessionStatusSelector");
    expect(auditScript).toContain("selectMeshBuildDialogRuntimeStatus");
    expect(auditScript).toContain("meshBuildDialogRuntimeStatusEquals");
    expect(auditScript).toContain("selectObjectVisualizationManifestStatus");
    expect(auditScript).toContain("objectVisualizationManifestStatusEquals");
    expect(auditScript).toContain("useFieldCatalogResource");
    expect(auditScript).toContain("status?.resources.field_revision");
    expect(auditScript).toContain("fullmag.viewport3d.buildViewport3DTopologyRenderModel");
    expect(auditScript).toContain("fullmag.api.requestBinaryResource.topology");
    expect(auditScript).toContain("fullmag.viewport3d.buildFdmCuboidInstanceModel");
    expect(auditScript).toContain("fullmag.viewport3d.buildVectorGlyphInstances");
    expect(auditScript).toContain("fullmag.viewport3d.uploadVectorGlyphColors");
    expect(auditScript).toContain("fullmag.viewport3d.uploadVectorGlyphMatrices");
    expect(auditScript).toContain("checkFdmCuboidChunkedUpload");
    expect(auditScript).toContain("buildFdmCuboidUploadBatches");
    expect(auditScript).toContain("checkFdmVectorSegmentCache");
    expect(auditScript).toContain("fdmVectorSegmentCache");
    expect(auditScript).toContain("checkFdmCuboidSceneModelReuse");
    expect(auditScript).toContain("fdmSurfaceInstanceModel");
    expect(auditScript).toContain("fdmInstanceModel: fdmSurfaceInstanceModel");
    expect(auditScript).toContain("instanceModel={fdmInstanceModel}");
    expect(auditScript).toContain("cachedFdmVectorSegments");
    expect(auditScript).toContain("checkTopologyPositionConversionCache");
    expect(auditScript).toContain("topologyPositionCache");
    expect(auditScript).toContain("Float32Array.from(topology.positions)");
    expect(auditScript).toContain("checkTopologyIndexBufferCache");
    expect(auditScript).toContain("topologySurfaceIndexCache");
    expect(auditScript).toContain("topologyVolumeEdgeIndexCache");
    expect(auditScript).toContain("checkMeshQualityVertexColorCache");
    expect(auditScript).toContain("meshQualityVertexColorCache");
    expect(auditScript).toContain("cachedMeshQualityVertexColors");
    expect(auditScript).toContain("checkFooterTelemetryIsOptIn");
    expect(auditScript).toContain("selectFooterTelemetryStatus");
    expect(auditScript).toContain("footerTelemetryStatusEquals");
    expect(auditScript).toContain("(sessionStatus) => sessionStatus.data");
    expect(auditScript).toContain('useState<FooterTabId>("telemetry")');
    expect(auditScript).toContain("checkViewportSmokeComputeMetrics");
    expect(auditScript).toContain("checkComputePerformanceSmokeScript");
    expect(auditScript).toContain("checkComputePerformanceMicrobenchCoverage");
    expect(auditScript).toContain("checkAnalysisPlotsStableResourceInputs");
    expect(auditScript).toContain("checkAnalysisPlotDecimation");
    expect(auditScript).toContain("src/modules/analysis-plots/AnalysisPlotsModule.tsx");
    expect(auditScript).toContain("src/modules/analysis-plots/tableRowsAdapter.ts");
    expect(auditScript).toContain("src/modules/analysis-plots/chartTableModel.ts");
    expect(auditScript).toContain("src/modules/analysis-plots/analysisPlotsModel.ts");
    expect(auditScript).toContain("src/modules/analysis-plots/useAnalysisPlotsController.ts");
    expect(auditScript).toContain("ANALYSIS_SCALAR_COLUMNS");
    expect(auditScript).toContain('decimation: "minmax_lttb"');
    expect(auditScript).toContain("targetPoints: clampInteger(");
    expect(auditScript).toContain("Number.isFinite(x) && Number.isFinite(y)");
    expect(auditScript).toContain("DEFAULT_TABLE_CHART_COLUMNS");
    expect(auditScript).toContain("mergeTableRows");
    expect(auditScript).toContain("computePerformanceMicrobench.test.ts");
    expect(auditScript).toContain("makeLargeTopologyBuffer");
    expect(auditScript).toContain("makeLargeQualityBuffer");
    expect(auditScript).toContain("makeLargeVectorField");
    expect(auditScript).toContain("assertUnderBudget");
    expect(auditScript).toContain("decodeTopology(makeLargeTopologyBuffer");
    expect(auditScript).toContain("decodeMeshQualityData(makeLargeQualityBuffer");
    expect(auditScript).toContain("buildVertexScalarColorsChunked(makeLargeVectorField");
    expect(auditScript).toContain("smoke-compute-performance.mjs");
    expect(auditScript).toContain("FORBIDDEN_ACCEPTANCE_RESOURCE_PATHS");
    expect(auditScript).toContain("assertNoImmediateResultResourceReloads");
    expect(auditScript).toContain("COMPUTE_VIEWPORT_GESTURE_FORBIDDEN_REQUEST_PREFIXES");
    expect(auditScript).toContain("verifyViewport3DGesturesDuringSolve");
    expect(auditScript).toContain("viewportGestureProof");
    expect(auditScript).toContain("recordViewportGestureRequests");
    expect(auditScript).toContain("previousCameraSignature");
    expect(auditScript).toContain("nextCameraSignature = await waitForCameraSignatureChange(");
    expect(auditScript).toContain("resultResourceRequestCount");
    expect(auditScript).toContain(DATA_SCALARS_PATH);
    expect(auditScript).toContain(SIMULATION_SOLVER_ENERGIES_CURRENT_PATH);
    expect(auditScript).toContain(SIMULATION_SOLVER_ENERGIES_HISTORY_PATH);
    expect(auditScript).toContain("simulation\\\\/objects\\\\/[^/]+\\\\/metrics");
    expect(auditScript).toContain("checkShellSelectorHooks");
    expect(auditScript).toContain("checkObjectVisualizationSelectorHooks");
    expect(auditScript).toContain("checkViewport3DObjectVisualizationSelector");
    expect(auditScript).toContain("selectViewport3DObjectVisualizationSnapshot");
    expect(auditScript).toContain("viewport3DObjectVisualizationSnapshotEquals");
    expect(auditScript).toContain("checkGeometryObjectPanelVisualizationSelector");
    expect(auditScript).toContain("useObjectVisualizationController");
    expect(auditScript).toContain("geometryObjectVisualizationColorsEquals");
    expect(auditScript).toContain("resolveGeometryObjectVisualizationColors");
    expect(auditScript).toContain("checkCommandShortcutConnector");
    expect(auditScript).toContain("checkFooterDiagnosticsBatching");
    expect(auditScript).toContain("newestFirstEntries");
    expect(auditScript).toContain("Object.freeze(");
    expect(auditScript).toContain("[...this.entries].reverse()");
    expect(auditScript).toContain("this.newestFirstEntries = null");
    expect(auditScript).toContain("checkPerformanceDiagnosticsExport");
    expect(auditScript).toContain("startPerformanceMeasureDiagnostics");
    expect(auditScript).toContain("channel: \"performance\"");
    expect(auditScript).toContain("checkVisualizationPatchHotPath");
    expect(auditScript).toContain("checkRibbonSliderCommandDebounce");
    expect(auditScript).toContain("SLIDER_COMMAND_DEBOUNCE_MS");
    expect(auditScript).toContain("useDebouncedSliderCommand");
    expect(auditScript).toContain("checkReactRenderProfilerInstrumentation");
    expect(auditScript).toContain("WorkspaceRenderProfiler");
    expect(auditScript).toContain("fullmag.react.render.RibbonModule");
    expect(auditScript).toContain("VisualizationRegistrySyncController.queuePatch");
    expect(auditScript).toContain("visualizationPatchSatisfiesPatch");
    expect(auditScript).toContain("mergeQueuedVisualizationPatch");
    expect(auditScript).toContain("VisualizationRegistrySyncController queued merge");
    expect(auditScript).toContain("deepMerge");
    expect(auditScript).toContain("ObjectVisualizationController.samePatch");
    expect(auditScript).toContain("Object.is");
    expect(auditScript).toContain("installComputePerformanceProbe");
    expect(auditScript).toContain("collectComputePerformanceProbe");
    expect(auditScript).toContain("COMPUTE_RESPONSIVENESS_PROBE_INTERVAL_MS");
    expect(auditScript).toContain("startResponsivenessProbe");
    expect(auditScript).toContain("maxResponsivenessDelayMs");
    expect(auditScript).toContain("totalResponsivenessDelayMs");
    expect(auditScript).toContain("delayedResponsivenessTickCount");
    expect(auditScript).toContain("BINARY_RESOURCE_MEASURE_NAMES");
    expect(auditScript).toContain("fullmag.api.requestBinaryResource.topology");
    expect(auditScript).toContain("fullmag.api.requestBinaryResource.mesh-quality-data");
    expect(auditScript).toContain("fullmag.api.requestBinaryResource.field-vector");
    expect(auditScript).toContain("binaryResourceMeasureCount");
    expect(auditScript).toContain("binaryResourceMeasureTotals");
    expect(auditScript).toContain("useLayoutSelector");
    expect(auditScript).toContain("useLayout selector equality");
    expect(auditScript).toContain("explorer store selector equality");
    expect(auditScript).toContain("useSelectionSelector");
    expect(auditScript).toContain("useSelectionActions");
    expect(auditScript).toContain("src/modules/inspector/InspectorModule.tsx");
    expect(auditScript).toContain("src/modules/viewport-3d/Viewport3DModule.tsx");
    expect(auditScript).toContain("runtimeResourceDataRef.current");
    expect(auditScript).toContain("listNewestFirst");
    expect(auditScript).toContain("queueMicrotask");
    expect(auditScript).toContain('"longtask"');
  });
});

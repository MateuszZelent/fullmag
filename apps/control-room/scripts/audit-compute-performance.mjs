import { readFileSync } from "node:fs";
import path from "node:path";

const appRoot = process.cwd();
const runtimeCommandsPath = path.join(
  appRoot,
  "src/kernel/runtime/studyRuntimeCommandContributions.ts",
);
const realtimeBridgePath = path.join(
  appRoot,
  "src/kernel/realtime/RealtimeInvalidationBridge.ts",
);
const controlRoomApiPath = path.join(
  appRoot,
  "src/kernel/api/ControlRoomApi.ts",
);
const binaryDecodeSchedulerPath = path.join(
  appRoot,
  "src/kernel/api/binaryDecodeScheduler.ts",
);
const binaryDecodePayloadPath = path.join(
  appRoot,
  "src/kernel/api/binaryDecodePayload.ts",
);
const binaryDecodeWorkerPath = path.join(
  appRoot,
  "src/kernel/api/binaryDecodeWorker.ts",
);
const useResourcePath = path.join(
  appRoot,
  "src/kernel/resources/useResource.ts",
);
const useSessionStatusPath = path.join(
  appRoot,
  "src/kernel/resources/useSessionStatus.ts",
);
const studyRuntimeResourcesPath = path.join(
  appRoot,
  "src/kernel/resources/studyRuntimeResources.ts",
);
const footerModulePath = path.join(
  appRoot,
  "src/modules/footer/FooterModule.tsx",
);
const footerTelemetryPath = path.join(
  appRoot,
  "src/modules/footer/FooterTelemetry.tsx",
);
const kernelProviderPath = path.join(appRoot, "src/kernel/KernelProvider.tsx");
const requestDiagnosticsControllerPath = path.join(
  appRoot,
  "src/kernel/api/RequestDiagnosticsController.ts",
);
const commandDiagnosticsControllerPath = path.join(
  appRoot,
  "src/kernel/commands/CommandDiagnosticsController.ts",
);
const performanceMeasureDiagnosticsPath = path.join(
  appRoot,
  "src/kernel/performance/performanceMeasureDiagnostics.ts",
);
const browserActivityDiagnosticsPath = path.join(
  appRoot,
  "src/kernel/performance/browserActivityDiagnostics.ts",
);
const reactRenderProfilerPath = path.join(
  appRoot,
  "src/kernel/performance/reactRenderProfiler.tsx",
);
const footerModelPath = path.join(
  appRoot,
  "src/modules/footer/footerModel.ts",
);
const appMenuBarPath = path.join(
  appRoot,
  "src/kernel/layout/AppMenuBar.tsx",
);
const useLayoutPath = path.join(appRoot, "src/kernel/layout/useLayout.ts");
const simulationStartupOverlayPath = path.join(
  appRoot,
  "src/kernel/layout/SimulationStartupOverlay.tsx",
);
const useSelectionPath = path.join(
  appRoot,
  "src/kernel/selection/useSelection.ts",
);
const selectionControllerPath = path.join(
  appRoot,
  "src/kernel/selection/SelectionController.ts",
);
const selectionTypesPath = path.join(
  appRoot,
  "src/kernel/selection/selectionTypes.ts",
);
const explorerStorePath = path.join(
  appRoot,
  "src/modules/explorer/explorerStore.ts",
);
const explorerModulePath = path.join(
  appRoot,
  "src/modules/explorer/ExplorerModule.tsx",
);
const ribbonModulePath = path.join(
  appRoot,
  "src/modules/ribbon/RibbonModule.tsx",
);
const objectVisualizationHookPath = path.join(
  appRoot,
  "src/kernel/visualization/useObjectVisualization.ts",
);
const objectVisualizationControllerPath = path.join(
  appRoot,
  "src/kernel/visualization/ObjectVisualizationController.ts",
);
const visualizationSyncControllerPath = path.join(
  appRoot,
  "src/kernel/visualization/VisualizationRegistrySyncController.ts",
);
const objectVisualizationPanelPath = path.join(
  appRoot,
  "src/modules/inspector/panels/ObjectVisualizationPanel.tsx",
);
const objectGeneralPanelPath = path.join(
  appRoot,
  "src/modules/inspector/panels/ObjectGeneralPanel.tsx",
);
const meshDetailsModelPath = path.join(
  appRoot,
  "src/modules/inspector/panels/mesh-details/useMeshDetailsModel.ts",
);
const airboxMeshPolicyPanelPath = path.join(
  appRoot,
  "src/modules/inspector/panels/AirboxMeshPolicyPanel.tsx",
);
const studyInspectorPanelPath = path.join(
  appRoot,
  "src/modules/inspector/panels/StudyInspectorPanel.tsx",
);
const meshBuildDialogPath = path.join(
  appRoot,
  "src/modules/overlay/MeshBuildDialog.tsx",
);
const ribbonMenuRendererPath = path.join(
  appRoot,
  "src/modules/ribbon/RibbonMenuRenderer.tsx",
);
const viewportSmokePath = path.join(
  appRoot,
  "scripts/smoke-viewport-3d.mjs",
);
const computePerformanceSmokePath = path.join(
  appRoot,
  "scripts/smoke-compute-performance.mjs",
);
const computePerformanceMicrobenchPath = path.join(
  appRoot,
  "src/kernel/performance/computePerformanceMicrobench.test.ts",
);
const analysisPlotsModulePath = path.join(
  appRoot,
  "src/modules/analysis-plots/AnalysisPlotsModule.tsx",
);
const analysisPlotsControllerPath = path.join(
  appRoot,
  "src/modules/analysis-plots/useAnalysisPlotsController.ts",
);
const analysisPlotsModelPath = path.join(
  appRoot,
  "src/modules/analysis-plots/analysisPlotsModel.ts",
);
const analysisPlotsViewPath = path.join(
  appRoot,
  "src/modules/analysis-plots/AnalysisPlotsView.tsx",
);
const analysisTableRowsAdapterPath = path.join(
  appRoot,
  "src/modules/analysis-plots/tableRowsAdapter.ts",
);
const chartTableModelPath = path.join(
  appRoot,
  "src/modules/analysis-plots/chartTableModel.ts",
);
const broadSessionStatusConsumerPaths = [
  "src/modules/explorer/ExplorerModule.tsx",
  "src/modules/ribbon/RibbonModule.tsx",
  "src/modules/footer/FooterTelemetry.tsx",
  "src/modules/status-bar/StatusBarModule.tsx",
].map((relativePath) => path.join(appRoot, relativePath));
const shellSelectorConsumerContracts = [
  {
    forbid: ["useLayout("],
    path: "src/kernel/layout/WorkspaceDockLayout.tsx",
    require: ["useLayoutSelector"],
  },
  {
    forbid: ["useLayout(", "useSelection(", "useObjectVisualization("],
    path: "src/modules/ribbon/RibbonModule.tsx",
    require: [
      "useLayoutSelector",
      "useSelectionSelector",
      "useObjectVisualizationSelector",
    ],
  },
  {
    forbid: ["useExplorerStore(", "useSelection("],
    path: "src/modules/explorer/ExplorerModule.tsx",
    require: ["useExplorerStoreSelector", "useSelectionSelector"],
  },
  {
    forbid: ["useSelection(", "useSessionStatus("],
    path: "src/modules/footer/FooterTelemetry.tsx",
    require: ["useSelectionSelector", "useSessionStatusSelector"],
  },
  {
    forbid: ["useSelection("],
    path: "src/modules/inspector/InspectorModule.tsx",
    require: ["useSelectionSelector"],
  },
  {
    forbid: ["useSelection("],
    path: "src/modules/viewport-3d/Viewport3DModule.tsx",
    require: ["useSelectionActions", "useSelectionSelector"],
  },
].map((contract) => ({
  ...contract,
  absolutePath: path.join(appRoot, contract.path),
}));
const viewportSceneModelPath = path.join(
  appRoot,
  "src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts",
);
const viewportModulePath = path.join(
  appRoot,
  "src/modules/viewport-3d/Viewport3DModule.tsx",
);
const fdmCuboidLayerPath = path.join(
  appRoot,
  "src/modules/viewport-3d/layers/FdmCuboidLayer.tsx",
);
const vectorFieldLayerPath = path.join(
  appRoot,
  "src/modules/viewport-3d/layers/VectorFieldLayer.tsx",
);
const topologyRenderModelPath = path.join(
  appRoot,
  "src/modules/viewport-3d/viewport3dRenderModel.ts",
);
const primitiveModelPath = path.join(
  appRoot,
  "src/modules/viewport-3d/viewport3dPrimitiveModel.ts",
);
const qualityMappingPath = path.join(
  appRoot,
  "src/modules/viewport-3d/viewport3dQualityMapping.ts",
);
const binaryResourcePerformanceMeasureNames = [
  "fullmag.api.requestBinaryResource.topology",
  "fullmag.api.requestBinaryResource.topology.transport",
  "fullmag.api.requestBinaryResource.topology.decode",
  "fullmag.api.requestBinaryResource.mesh-quality-data",
  "fullmag.api.requestBinaryResource.mesh-quality-data.transport",
  "fullmag.api.requestBinaryResource.mesh-quality-data.decode",
  "fullmag.api.requestBinaryResource.field-vector",
  "fullmag.api.requestBinaryResource.field-vector.transport",
  "fullmag.api.requestBinaryResource.field-vector.decode",
];

const failures = [];

checkComputeCommandInvalidationScope();
checkStudyRunCommandInvalidationScope();
checkRealtimeSessionStatusFanout();
checkBinaryDecodeScheduler();
checkControlRoomApiBinaryPerformanceMarks();
checkSessionStatusSelectors();
checkExplorerModuleSessionStatusSelector();
checkRibbonModuleSessionStatusSelector();
checkHeaderSessionStatusSelector();
checkSimulationStartupOverlaySessionStatusSelector();
checkRuntimeControlSessionStatusSelector();
checkStudyRuntimeCommandResourceDataSessionStatusSelector();
checkFieldCatalogResourceSeparation();
checkObjectVisualizationPanelSessionStatusSelector();
checkObjectVisualizationPanelVisualizationSelector();
checkObjectVisualizationPanelNumberFieldCommitBoundary();
checkMeshDetailsPanelSessionStatusSelector();
checkAirboxMeshPolicyPanelSessionStatusSelector();
checkStudyInspectorPanelSessionStatusSelector();
checkMeshBuildDialogSessionStatusSelector();
checkShellSelectorHooks();
checkSelectionComparatorHotPath();
checkObjectVisualizationSelectorHooks();
checkViewport3DObjectVisualizationSelector();
checkObjectGeneralPanelVisualizationSelector();
checkCommandShortcutConnector();
checkFooterDiagnosticsBatching();
checkPerformanceDiagnosticsExport();
checkReactRenderProfilerInstrumentation();
checkVisualizationPatchHotPath();
checkRibbonSliderCommandDebounce();
checkViewportPerformanceMarks();
checkPrimitiveGeometryKeyHotPath();
checkTopologyPositionConversionCache();
checkTopologyIndexBufferCache();
checkVectorSurfaceNormalCache();
checkMeshQualityVertexColorCache();
checkFdmCuboidChunkedUpload();
checkVectorGlyphChunkedUpload();
checkFdmVectorSegmentCache();
checkFdmCuboidSceneModelReuse();
checkFooterTelemetryIsOptIn();
checkViewportSmokeComputeMetrics();
checkComputePerformanceSmokeScript();
checkComputePerformanceMicrobenchCoverage();
checkAnalysisPlotsStableResourceInputs();
checkAnalysisPlotDecimation();

if (failures.length > 0) {
  console.error(`Compute performance audit failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log("Compute performance audit passed.");

function checkComputeCommandInvalidationScope() {
  const source = readFileSync(runtimeCommandsPath, "utf8");
  const controlHelper = blockBetween(
    source,
    "function invalidateRuntimeControlResources",
    "function invalidateSolverProfileResources",
  );
  const computeFields = blockBetween(
    source,
    'id: "study.compute-fields"',
    'id: "study.compute-energies"',
  );
  const computeEnergies = blockBetween(source, 'id: "study.compute-energies"', "\n];");

  requireTokens(controlHelper, "invalidateRuntimeControlResources", [
    "SIMULATION_COMMANDS_PATH",
    "SIMULATION_STAGES_EXECUTION_PATH",
    "SIMULATION_SOLVER_STATUS_PATH",
  ]);
  forbidTokens(controlHelper, "invalidateRuntimeControlResources", [
    "SESSION_STATUS_RESOURCE_KEY",
    "DATA_FIELDS_PATH",
    "DATA_SCALARS_PATH",
    "SIMULATION_SOLVER_ENERGIES_CURRENT_PATH",
    "SIMULATION_OBJECT_METRICS_PATH",
    "invalidatePrefix",
  ]);

  for (const [label, block] of [
    ["study.compute-fields", computeFields],
    ["study.compute-energies", computeEnergies],
  ]) {
    requireTokens(block, label, [
      "submitRuntimeCommand(",
      "buildRuntimeCommandFromContext(",
    ]);
    forbidTokens(block, label, [
      "invalidateRuntimeResources",
      "invalidateEnergyResources",
      "DATA_FIELDS_PATH",
      "DATA_SCALARS_PATH",
      "SIMULATION_SOLVER_ENERGIES_CURRENT_PATH",
      "SIMULATION_SOLVER_ENERGIES_HISTORY_PATH",
      "SIMULATION_OBJECT_METRICS_PATH",
      "SESSION_STATUS_RESOURCE_KEY",
      "invalidatePrefix",
    ]);
  }
}

function checkStudyRunCommandInvalidationScope() {
  const source = readFileSync(runtimeCommandsPath, "utf8");
  const submitHelper = blockBetween(
    source,
    "async function submitRuntimeCommand",
    "function record",
  );
  const studyRun = blockBetween(
    source,
    `runtimeCommand(
    "study.run"`,
    `runtimeCommand(
    "study.pause"`,
  );

  requireTokens(studyRun, "study.run command", [
    '"study.run"',
    '"solve"',
    '"Study compute command accepted."',
  ]);
  requireTokens(submitHelper, "submitRuntimeCommand invalidation scope", [
    "refreshRuntimeCommandPrecondition",
    "invalidateRuntimeControlResources(",
    "commandRevision(response, `study:${refreshedCommand.kind}`)",
  ]);
  forbidTokens(submitHelper, "submitRuntimeCommand invalidation scope", [
    "invalidateRuntimeResources",
    "SESSION_STATUS_RESOURCE_KEY",
    "SIMULATION_RUN_CURRENT_PATH",
    "DATA_FIELDS_PATH",
    "DATA_SCALARS_PATH",
    "invalidatePrefix",
  ]);
}

function checkRealtimeSessionStatusFanout() {
  const source = readFileSync(realtimeBridgePath, "utf8");
  const whitelist = blockBetween(
    source,
    "SESSION_STATUS_RECOMMENDED_FETCHES",
    "function shouldInvalidateSessionStatus",
  );
  const predicate = blockBetween(
    source,
    "function shouldInvalidateSessionStatus",
    "export class RealtimeInvalidationBridge",
  );

  requireTokens(whitelist, "SESSION_STATUS_RECOMMENDED_FETCHES", [
    "SIMULATION_SOLVER_STATUS_PATH",
  ]);
  forbidTokens(whitelist, "SESSION_STATUS_RECOMMENDED_FETCHES", [
    "SIMULATION_COMMANDS_PATH",
    "DATA_FIELDS_PATH",
    "DATA_SCALARS_PATH",
    "VISUALIZATION_STATE_PATH",
    "VISUALIZATION_CLIENT_ACKS_PATH",
    "SIMULATION_SOLVER_ENERGIES_CURRENT_PATH",
    "SIMULATION_OBJECT_METRICS_PATH",
  ]);
  requireTokens(predicate, "shouldInvalidateSessionStatus", [
    "SESSION_STATUS_RECOMMENDED_FETCHES.has(recommendedFetch)",
  ]);
  forbidTokens(predicate, "shouldInvalidateSessionStatus", [
    "recommendedFetch !== VISUALIZATION_CLIENT_ACKS_PATH",
    "recommendedFetch !== undefined ||",
  ]);
}

function checkBinaryDecodeScheduler() {
  const controlRoomApi = readFileSync(controlRoomApiPath, "utf8");
  const scheduler = readFileSync(binaryDecodeSchedulerPath, "utf8");
  const payload = readFileSync(binaryDecodePayloadPath, "utf8");
  const worker = readFileSync(binaryDecodeWorkerPath, "utf8");
  const binaryRequest = blockBetween(
    controlRoomApi,
    "private async requestBinaryResource",
    "private async executeBinaryOpenApiFetch",
  );

  requireTokens(controlRoomApi, "ControlRoomApi binary decode scheduler", [
    "binaryDecodeScheduler?: BinaryDecodeScheduler",
    "binaryDecodeScheduler = createBinaryDecodeScheduler()",
    "this.binaryDecodeScheduler = binaryDecodeScheduler",
    "type BinaryDecoderKind",
    '"topology"',
    '"mesh-quality-data"',
    '"field-vector"',
  ]);
  requireTokens(binaryRequest, "requestBinaryResource", [
    "decoderKind: BinaryDecoderKind",
    "await this.binaryDecodeScheduler",
    "decodeInline: decode",
    "kind: decoderKind",
  ]);
  forbidTokens(binaryRequest, "requestBinaryResource", [
    "const data = decode(buffer);",
  ]);

  requireTokens(scheduler, "binaryDecodeScheduler", [
    'new Worker(new URL("./binaryDecodeWorker.ts", import.meta.url)',
    "decodeInline(buffer)",
    'export type { BinaryDecoderKind } from "./binaryDecodePayload"',
  ]);
  forbidTokens(scheduler, "binaryDecodeScheduler", [
    "decodeBinaryPayload(",
    "transferablesForDecodedPayload(",
  ]);
  requireTokens(payload, "binaryDecodePayload", [
    "decodeBinaryPayload",
    "transferablesForDecodedPayload",
    "decodeFieldVector(buffer)",
    "decodeMeshQualityData(buffer)",
    "decodeTopology(buffer)",
  ]);
  requireTokens(worker, "binaryDecodeWorker", [
    'from "./binaryDecodePayload"',
    "decodeBinaryPayload(kind, buffer)",
    "transferablesForDecodedPayload(data)",
  ]);
  forbidTokens(worker, "binaryDecodeWorker", [
    'from "./binaryDecodeScheduler"',
  ]);
}

function checkControlRoomApiBinaryPerformanceMarks() {
  const controlRoomApi = readFileSync(controlRoomApiPath, "utf8");
  const binaryRequest = blockBetween(
    controlRoomApi,
    "private async requestBinaryResource",
    "private async executeBinaryOpenApiFetch",
  );

  requireTokens(controlRoomApi, "ControlRoomApi binary performance marks", [
    "async function measureControlRoomApiPerformance",
    "performanceTarget.mark(startMark)",
    "performanceTarget.measure(name, startMark, endMark)",
    "performanceTarget.clearMarks?.(startMark)",
    "performanceTarget.clearMarks?.(endMark)",
  ]);
  requireTokens(binaryRequest, "requestBinaryResource performance marks", [
    "measureControlRoomApiPerformance",
    "`fullmag.api.requestBinaryResource.${decoderKind}`",
    "measureBase",
    "`${measureBase}.transport`",
    "`${measureBase}.decode`",
  ]);

  const decoderKinds = new Set(
    binaryResourcePerformanceMeasureNames.map((measureName) =>
      measureName.replace("fullmag.api.requestBinaryResource.", "").split(".")[0],
    ),
  );
  for (const decoderKind of decoderKinds) {
    if (!controlRoomApi.includes(`"${decoderKind}"`)) {
      failures.push(
        `ControlRoomApi binary performance marks must cover ${decoderKind}.`,
      );
    }
  }
}

function checkSessionStatusSelectors() {
  const useResource = readFileSync(useResourcePath, "utf8");
  const useSessionStatus = readFileSync(useSessionStatusPath, "utf8");

  requireTokens(useResource, "useResourceSelector", [
    "export function useResourceSelector",
    "selector(visibleState)",
    "isEqual(previous.selected, selected)",
  ]);
  requireTokens(useSessionStatus, "useSessionStatusSelector", [
    "export function useSessionStatusSelector",
    "useResourceSelector",
    "SESSION_STATUS_RESOURCE_KEY",
  ]);

  requireTokens(useSessionStatus, "session status narrow revision", [
    "SESSION_STATUS_REVISION_RESOURCE_KEYS",
    "command_completion_revision",
    "commands_revision",
    "mesh_revision",
  ]);
  forbidTokens(useSessionStatus, "session status narrow revision", [
    "Object.values(status.resources)",
    "Math.max(...Object.values",
  ]);

  for (const consumerPath of broadSessionStatusConsumerPaths) {
    const source = readFileSync(consumerPath, "utf8");
    const label = relativeAppPath(consumerPath);
    requireTokens(source, label, ["useSessionStatusSelector"]);
    forbidTokens(source, label, [
      "const sessionStatus = useSessionStatus()",
      "const { data: status } = useSessionStatus()",
      "const status = useSessionStatus()",
    ]);
  }
}

function checkExplorerModuleSessionStatusSelector() {
  const source = readFileSync(explorerModulePath, "utf8");
  requireTokens(source, "ExplorerModule session status selector", [
    "selectExplorerModelRuntimeStatus",
    "explorerModelRuntimeStatusEquals",
    "useSessionStatusSelector",
    "isEqual: explorerModelRuntimeStatusEquals",
    "shouldLoadRuntimeMeshSummary(modelTabActive, sessionStatusData)",
    "shouldLoadRuntimeMeshBuild(modelTabActive, sessionStatusData)",
    "shouldLoadRuntimeMeshManifest(modelTabActive, sessionStatusData)",
    "shouldLoadRuntimeStageExecution(",
  ]);
  forbidTokens(source, "ExplorerModule session status selector", [
    "import { useSessionStatus }",
    "const sessionStatus = useSessionStatus()",
    "sessionStatus.data",
  ]);
}

function checkRibbonModuleSessionStatusSelector() {
  const source = readFileSync(ribbonModulePath, "utf8");
  requireTokens(source, "RibbonModule session status selector", [
    "selectRibbonRuntimeStatus",
    "ribbonRuntimeStatusEquals",
    "useSessionStatusSelector",
    "isEqual: ribbonRuntimeStatusEquals",
    "field_revision",
    "fields_revision",
    "shouldLoadRuntimeMeshBuild(needsMeshResources, sessionStatusData)",
    "shouldLoadRuntimeMeshManifest(",
    "shouldLoadRuntimeMeshSummary(",
    "shouldLoadRuntimeStageExecution(",
    "[SESSION_STATUS_RESOURCE_KEY]: needsRuntimeResources",
  ]);
  forbidTokens(source, "RibbonModule session status selector", [
    "import { useSessionStatus }",
    "const sessionStatus = useSessionStatus()",
    "sessionStatus.data",
  ]);
}

function checkHeaderSessionStatusSelector() {
  const source = readFileSync(appMenuBarPath, "utf8");
  requireTokens(source, "AppMenuBar header session selector", [
    "selectHeaderSessionSource",
    "headerSessionSourceEquals",
    "useSessionStatusSelector(selectHeaderSessionSource",
    "isEqual: headerSessionSourceEquals",
  ]);
  forbidTokens(source, "AppMenuBar header session selector", [
    "import { useSessionStatus }",
    "const sessionStatus = useSessionStatus()",
  ]);
}

function checkSimulationStartupOverlaySessionStatusSelector() {
  const source = readFileSync(simulationStartupOverlayPath, "utf8");
  requireTokens(source, "SimulationStartupOverlay session status selector", [
    "selectSimulationStartupOverlayResourceState",
    "simulationStartupOverlayResourceStateEquals",
    "startupResource.refetch",
  ]);
  requirePatterns(source, "SimulationStartupOverlay session status selector", [
    [
      /useSessionStatusSelector\(\s*selectSimulationStartupOverlayResourceState/,
      "useSessionStatusSelector(selectSimulationStartupOverlayResourceState)",
    ],
  ]);
  forbidTokens(source, "SimulationStartupOverlay session status selector", [
    "useSessionStatus,",
    "const sessionStatus = useSessionStatus();",
    "sessionStatus.refetch",
  ]);
}

function checkRuntimeControlSessionStatusSelector() {
  const source = readFileSync(studyRuntimeResourcesPath, "utf8");
  const controlHook = blockBetween(
    source,
    "export function useRuntimeCommandControlResourceData",
    "export function useObjectMetricsResource",
  );

  requireTokens(source, "runtime command control session selector", [
    "selectRuntimeCommandControlSessionStatus",
    "runtimeCommandControlSessionStatusEquals",
    "RUNTIME_COMMAND_CONTROL_STATUS_RESOURCE_KEYS",
    "previous.run?.run_id !== next.run?.run_id",
  ]);
  requireTokens(controlHook, "useRuntimeCommandControlResourceData", [
    "useSessionStatusSelector(selectRuntimeCommandControlSessionStatus",
    "isEqual: runtimeCommandControlSessionStatusEquals",
  ]);
  forbidTokens(controlHook, "useRuntimeCommandControlResourceData", [
    "useSessionStatus()",
    "sessionStatus.data",
  ]);
}

function checkStudyRuntimeCommandResourceDataSessionStatusSelector() {
  const source = readFileSync(studyRuntimeResourcesPath, "utf8");
  const commandBundleHook = blockBetween(
    source,
    "export function useStudyRuntimeCommandResourceData",
    "export function useRuntimeCommandControlResourceData",
  );

  requireTokens(source, "study runtime command session selector", [
    "selectStudyRuntimeCommandSessionStatus",
    "studyRuntimeCommandSessionStatusEquals",
  ]);
  requirePatterns(commandBundleHook, "useStudyRuntimeCommandResourceData", [
    [
      /useSessionStatusSelector\(\s*selectStudyRuntimeCommandSessionStatus/,
      "useSessionStatusSelector(selectStudyRuntimeCommandSessionStatus)",
    ],
  ]);
  requireTokens(commandBundleHook, "useStudyRuntimeCommandResourceData", [
    "isEqual: studyRuntimeCommandSessionStatusEquals",
  ]);
  forbidTokens(commandBundleHook, "useStudyRuntimeCommandResourceData", [
    "useSessionStatus()",
    "sessionStatus.data",
  ]);
}

function checkFieldCatalogResourceSeparation() {
  const controlRoomApi = readFileSync(controlRoomApiPath, "utf8");
  const studyRuntimeResources = readFileSync(studyRuntimeResourcesPath, "utf8");
  const objectVisualizationPanel = readFileSync(
    objectVisualizationPanelPath,
    "utf8",
  );

  requireTokens(controlRoomApi, "ControlRoomApi field catalog facade", [
    "DATA_FIELDS_PATH",
    "FieldCatalogResource",
    "catalog: (options?: RequestOptions)",
    "requestJson<FieldCatalogResource>(DATA_FIELDS_PATH, options)",
  ]);
  requireTokens(studyRuntimeResources, "field catalog resource hook", [
    "export function useFieldCatalogResource",
    "api.data.fields.catalog({ signal })",
    "resourceKey: DATA_FIELDS_PATH",
  ]);
  requireTokens(objectVisualizationPanel, "ObjectVisualizationPanel field catalog separation", [
    "useFieldCatalogResource",
    "fieldCatalog.data",
    "fieldCatalog.status",
    "fieldCatalog={fieldCatalog}",
  ]);
  forbidTokens(objectVisualizationPanel, "ObjectVisualizationPanel field catalog separation", [
    "status?.resources.field_revision",
    "status?.resources.fields_revision",
  ]);
}

function checkObjectVisualizationPanelSessionStatusSelector() {
  const source = readFileSync(objectVisualizationPanelPath, "utf8");
  requireTokens(source, "ObjectVisualizationPanel session status selector", [
    "selectObjectVisualizationManifestStatus",
    "objectVisualizationManifestStatusEquals",
    "useSessionStatusSelector",
    "manifestStatus",
    "shouldLoadRuntimeMeshManifest(Boolean(target), manifestStatus)",
  ]);
  forbidTokens(source, "ObjectVisualizationPanel session status selector", [
    "import { useSessionStatus }",
    "const sessionStatus = useSessionStatus()",
    "sessionStatus.data",
  ]);
}

function checkObjectVisualizationPanelVisualizationSelector() {
  const source = readFileSync(objectVisualizationPanelPath, "utf8");
  requireTokens(source, "ObjectVisualizationPanel visualization selector", [
    "useObjectVisualizationController",
    "useObjectVisualizationSelector",
    "selectObjectVisualizationPanelSnapshot",
    "objectVisualizationPanelSnapshotEquals",
    "visualizationTargetPatchEquals",
    "visualizationTargetKey",
  ]);
  forbidTokens(source, "ObjectVisualizationPanel visualization selector", [
    "useObjectVisualizationRegistry()",
  ]);
}

function checkObjectVisualizationPanelNumberFieldCommitBoundary() {
  const source = readFileSync(objectVisualizationPanelPath, "utf8");
  const numberField = blockBetween(
    source,
    "function NumberField",
    "function displayControlDisabledDescription",
  );
  const wireframeSection = blockBetween(
    source,
    "function VisualizationWireframeSection",
    "function VisualizationVectorsSection",
  );
  const vectorsSection = blockBetween(
    source,
    "function VisualizationVectorsSection",
    "function VisualizationGeometryScopeSection",
  );
  const opacitySection = blockBetween(
    source,
    "function VisualizationOpacitySection",
    "function VisualizationOverridesSection",
  );

  requireTokens(numberField, "ObjectVisualizationPanel NumberField commit boundary", [
    "pendingValueRef",
    "queuedDraftValueRef",
    "window.requestAnimationFrame",
    "window.cancelAnimationFrame",
    "setDraftOverride(queuedValue)",
    "onPointerUp={flushDraft}",
    "onPointerCancel={flushDraft}",
    "onKeyUp={flushDraft}",
    "onBlur={flushDraft}",
  ]);
  forbidTokens(numberField, "ObjectVisualizationPanel NumberField commit boundary", [
    "window.setTimeout(",
    "onChange(event.target.value)",
    "onChange(Number(event.target.value))",
  ]);
  requireTokens(wireframeSection, "ObjectVisualizationPanel wireframe range debounce", [
    "<NumberField",
    'label="Wireframe opacity"',
    'patchNumber("wireframeOpacityPercent"',
  ]);
  requireTokens(vectorsSection, "ObjectVisualizationPanel vector range debounce", [
    "<NumberField",
    'label="Vector alpha"',
    'label="Vector thickness"',
    'label="Arrow length"',
    'label="Arrow budget"',
    'label="Extra surface gap"',
    'patchNumber("vectorAlphaPercent"',
    'patchNumber("vectorThickness"',
    'patchNumber("vectorLengthScale"',
    'patchNumber("vectorBudget"',
    'patchNumber("vectorSurfaceOffsetScale"',
  ]);
  requireTokens(opacitySection, "ObjectVisualizationPanel opacity range debounce", [
    "<NumberField",
    'label="Opacity"',
    "patch({ opacityPercent: value })",
  ]);
}

function checkMeshDetailsPanelSessionStatusSelector() {
  const source = readFileSync(meshDetailsModelPath, "utf8");
  requireTokens(source, "MeshDetailsPanel session status selector", [
    "selectMeshDetailsRuntimeStatus",
    "meshDetailsRuntimeStatusEquals",
    "useSessionStatusSelector",
    "runtimeStatus",
    "shouldLoadRuntimeMeshSummary(true, runtimeStatus)",
    "shouldLoadRuntimeMeshBuild(true, runtimeStatus)",
    "shouldLoadRuntimeMeshManifest(true, runtimeStatus)",
  ]);
  forbidTokens(source, "MeshDetailsPanel session status selector", [
    "import { useSessionStatus }",
    "const sessionStatus = useSessionStatus()",
    "sessionStatus.data",
  ]);
}

function checkAirboxMeshPolicyPanelSessionStatusSelector() {
  const source = readFileSync(airboxMeshPolicyPanelPath, "utf8");
  requireTokens(source, "AirboxMeshPolicyPanel session status selector", [
    "selectAirboxMeshPolicyRuntimeStatus",
    "airboxMeshPolicyRuntimeStatusEquals",
    "useSessionStatusSelector",
    "runtimeStatus",
    "shouldLoadRuntimeMeshSummary(true, runtimeStatus)",
  ]);
  forbidTokens(source, "AirboxMeshPolicyPanel session status selector", [
    "import { useSessionStatus }",
    "const sessionStatus = useSessionStatus()",
    "sessionStatus.data",
  ]);
}

function checkStudyInspectorPanelSessionStatusSelector() {
  const source = readFileSync(studyInspectorPanelPath, "utf8");
  requireTokens(source, "StudyInspectorPanel session status selector", [
    "selectStudyInspectorRuntimeStatus",
    "studyInspectorRuntimeStatusEquals",
    "useSessionStatusSelector",
    "runtimeStatus",
    "shouldLoadRuntimeCurrentRun(true, runtimeStatus)",
    "shouldLoadRuntimeStageExecution(true, runtimeStatus)",
    "shouldLoadRuntimeMeshBuild(true, runtimeStatus)",
    "shouldLoadRuntimeMeshManifest(true, runtimeStatus)",
    "shouldLoadRuntimeMeshSummary(true, runtimeStatus)",
    "shouldLoadRuntimeScalars(true, runtimeStatus)",
  ]);
  forbidTokens(source, "StudyInspectorPanel session status selector", [
    "import { useSessionStatus }",
    "const sessionStatus = useSessionStatus()",
    "sessionStatus.data",
  ]);
}

function checkMeshBuildDialogSessionStatusSelector() {
  const source = readFileSync(meshBuildDialogPath, "utf8");
  requireTokens(source, "MeshBuildDialog session status selector", [
    "selectMeshBuildDialogRuntimeStatus",
    "meshBuildDialogRuntimeStatusEquals",
    "useSessionStatusSelector",
    "runtimeStatus",
    "shouldLoadRuntimeMeshBuild(state.open, runtimeStatus)",
    "shouldLoadRuntimeMeshSummary(state.open, runtimeStatus)",
    "shouldLoadRuntimeMeshManifest(state.open, runtimeStatus)",
  ]);
  forbidTokens(source, "MeshBuildDialog session status selector", [
    "import { useSessionStatus }",
    "const sessionStatus = useSessionStatus()",
    "sessionStatus.data",
  ]);
}

function checkShellSelectorHooks() {
  const useLayout = readFileSync(useLayoutPath, "utf8");
  const useSelection = readFileSync(useSelectionPath, "utf8");
  const explorerStore = readFileSync(explorerStorePath, "utf8");
  const objectVisualization = readFileSync(objectVisualizationHookPath, "utf8");

  requireTokens(useLayout, "useLayout selector hooks", [
    "export function useLayoutSelector",
    "export function useLayoutActions",
  ]);
  requireTokens(useLayout, "useLayout selector equality", [
    "options: { isEqual?:",
    "useRef<{ selected: T } | null>(null)",
    "isEqual(previous.selected, selected)",
  ]);
  requireTokens(useSelection, "useSelection selector hook", [
    "export function useSelectionSelector",
  ]);
  requireTokens(explorerStore, "explorer store selector hook", [
    "export function useExplorerStoreSelector",
  ]);
  requireTokens(explorerStore, "explorer store selector equality", [
    "options: { isEqual?:",
    "useRef<{ selected: T } | null>(null)",
    "isEqual(previous.selected, selected)",
  ]);
  requireTokens(objectVisualization, "object visualization selector hook", [
    "export function useObjectVisualizationSelector",
  ]);

  for (const contract of shellSelectorConsumerContracts) {
    const source = readFileSync(contract.absolutePath, "utf8");
    requireTokens(source, contract.path, contract.require);
    forbidTokens(source, contract.path, contract.forbid);
  }
}

function checkSelectionComparatorHotPath() {
  const selectionTypes = readFileSync(selectionTypesPath, "utf8");
  const useSelection = readFileSync(useSelectionPath, "utf8");
  const selectionController = readFileSync(selectionControllerPath, "utf8");

  requireTokens(selectionTypes, "selection ref comparator", [
    "export function selectionRefEquals",
    "export function selectionSnapshotEquals",
    "switch (left.type)",
    "centroidEquals(left.centroid, right.centroid)",
  ]);
  requireTokens(useSelection, "useSelection selection comparator", [
    "export { selectionSnapshotEquals }",
  ]);
  requireTokens(selectionController, "SelectionController selection comparator", [
    "selectionRefEquals(prev.ref, this.state.ref)",
  ]);
  forbidTokens(selectionTypes, "selection ref comparator", ["JSON.stringify"]);
  forbidTokens(useSelection, "useSelection selection comparator", [
    "JSON.stringify",
  ]);
  forbidTokens(selectionController, "SelectionController selection comparator", [
    "JSON.stringify",
  ]);
}

function checkObjectVisualizationSelectorHooks() {
  const source = readFileSync(objectVisualizationHookPath, "utf8");
  requireTokens(source, "object visualization selector hook", [
    "export function useObjectVisualizationSelector",
    "isEqual(previous.selected, selected)",
    "selectedRef.current",
    "export function useObjectVisualizationController",
  ]);
}

function checkViewport3DObjectVisualizationSelector() {
  const moduleSource = readFileSync(viewportModulePath, "utf8");
  const sceneModelSource = readFileSync(viewportSceneModelPath, "utf8");

  requireTokens(sceneModelSource, "Viewport3D object visualization selector", [
    "useObjectVisualizationSelector",
    "selectViewport3DObjectVisualizationSnapshot",
    "viewport3DObjectVisualizationSnapshotEquals",
    "visualizationTargetKey",
    "pushViewportVisualizationTarget",
    "AIRBOX_VISUALIZATION_TARGET",
  ]);
  forbidTokens(moduleSource, "Viewport3DModule object visualization selector", [
    "useObjectVisualizationRegistry()",
    "objectVisualizationSnapshot",
  ]);
  forbidTokens(sceneModelSource, "Viewport3D object visualization selector", [
    "ReturnType<typeof useObjectVisualizationRegistry>",
  ]);
}

function checkObjectGeneralPanelVisualizationSelector() {
  const source = readFileSync(objectGeneralPanelPath, "utf8");
  requireTokens(source, "ObjectGeneralPanel visualization selector", [
    "useObjectVisualizationController",
    "useObjectVisualizationSelector",
    "resolveGeometryObjectVisualizationColors",
    "geometryObjectVisualizationColorsEquals",
    "shaderMonoColor",
    "wireframeColor",
  ]);
  forbidTokens(source, "ObjectGeneralPanel visualization selector", [
    "useObjectVisualizationRegistry()",
  ]);
}

function checkCommandShortcutConnector() {
  const source = readFileSync(kernelProviderPath, "utf8");
  const block = blockBetween(
    source,
    "function CommandShortcutConnector",
    "function VisualizationRegistrySyncConnector",
  );

  requireTokens(block, "CommandShortcutConnector", [
    "const startupVisible = useSimulationStartupOverlayVisibility()",
    "const runtimeResourceDataRef = useRef(runtimeResourceData)",
    "runtimeResourceDataRef.current = runtimeResourceData",
    "resourceData: runtimeResourceDataRef.current",
    "}, [kernel, startupVisible]);",
  ]);
  forbidTokens(block, "CommandShortcutConnector", [
    "useSessionStatus()",
    "resolveSimulationStartupOverlayState",
    "startupState.isVisible",
    "}, [kernel, runtimeResourceData, startupVisible]);",
    "}, [kernel, runtimeResourceData, startupState.isVisible]);",
  ]);
}

function checkFooterDiagnosticsBatching() {
  const footer = readFileSync(footerModulePath, "utf8");
  const requestDiagnostics = readFileSync(requestDiagnosticsControllerPath, "utf8");
  const commandDiagnostics = readFileSync(commandDiagnosticsControllerPath, "utf8");

  requireTokens(footer, "Footer diagnostics list order", [
    "kernel.diagnostics.listNewestFirst()",
    "kernel.commandDiagnostics.listNewestFirst()",
  ]);
  forbidTokens(footer, "Footer diagnostics list order", [
    "kernel.diagnostics.list().slice().reverse()",
    "kernel.commandDiagnostics.list().slice().reverse()",
  ]);

  for (const [label, source] of [
    ["RequestDiagnosticsController", requestDiagnostics],
    ["CommandDiagnosticsController", commandDiagnostics],
  ]) {
    requireTokens(source, label, [
      "private newestFirstEntries",
      "private notificationQueued = false",
      "this.newestFirstEntries = null",
      "listNewestFirst()",
      "Object.freeze(",
      "[...this.entries].reverse()",
      "private schedulePublish(): void",
      "queueMicrotask(() => {",
    ]);
    forbidTokens(source, label, [
      "private publish(): void",
      "return [...this.entries].reverse();",
    ]);
  }
}

function checkPerformanceDiagnosticsExport() {
  const performanceDiagnostics = readFileSync(
    performanceMeasureDiagnosticsPath,
    "utf8",
  );
  const browserActivityDiagnostics = readFileSync(
    browserActivityDiagnosticsPath,
    "utf8",
  );
  const kernelProvider = readFileSync(kernelProviderPath, "utf8");
  const requestDiagnostics = readFileSync(requestDiagnosticsControllerPath, "utf8");
  const footer = readFileSync(footerModulePath, "utf8");
  const footerModel = readFileSync(footerModelPath, "utf8");

  requireTokens(performanceDiagnostics, "performance measure diagnostics", [
    "startPerformanceMeasureDiagnostics",
    'observer.observe({ buffered: true, type: "measure" })',
    "namePrefix = DEFAULT_PERFORMANCE_MEASURE_PREFIX",
    'DEFAULT_PERFORMANCE_MEASURE_PREFIX = "fullmag."',
    "diagnostics.record({",
    'channel: "performance"',
    'method: "MEASURE"',
    'messageType: "measure"',
  ]);
  requireTokens(kernelProvider, "KernelProvider performance diagnostics", [
    "PerformanceDiagnosticsConnector",
    "startPerformanceMeasureDiagnostics",
    "startBrowserActivityDiagnostics",
    "stopMeasures();",
    "stopBrowserActivity();",
  ]);
  requireTokens(browserActivityDiagnostics, "browser activity diagnostics", [
    "startBrowserActivityDiagnostics",
    'observer.observe({ buffered: true, type: "longtask" })',
    'path: LONG_TASK_PATH',
    'LONG_TASK_PATH = "fullmag.browser.longtask"',
    'messageType: "longtask"',
  ]);
  requireTokens(requestDiagnostics, "RequestDiagnosticsController performance channel", [
    'export type TransportChannel = "http" | "performance" | "websocket"',
  ]);
  requireTokens(footer, "Footer performance diagnostics filter", [
    'setChannel("performance")',
    "HTTP + WS + Perf",
  ]);
  requireTokens(footerModel, "Footer performance diagnostics preview", [
    'entry.channel === "performance"',
    "`${direction} PERF ${entry.path}`",
  ]);
}

function checkReactRenderProfilerInstrumentation() {
  const profiler = readFileSync(reactRenderProfilerPath, "utf8");
  const shell = readFileSync(
    path.join(appRoot, "src/kernel/layout/WorkspaceShellClient.tsx"),
    "utf8",
  );
  const ribbon = readFileSync(
    path.join(appRoot, "src/modules/ribbon/RibbonModule.tsx"),
    "utf8",
  );
  const explorer = readFileSync(
    path.join(appRoot, "src/modules/explorer/ExplorerModule.tsx"),
    "utf8",
  );
  const viewport = readFileSync(
    path.join(appRoot, "src/modules/viewport-3d/Viewport3DModule.tsx"),
    "utf8",
  );
  const footer = readFileSync(
    path.join(appRoot, "src/modules/footer/FooterModule.tsx"),
    "utf8",
  );
  const smoke = readFileSync(viewportSmokePath, "utf8");

  requireTokens(profiler, "react render profiler", [
    "export function WorkspaceRenderProfiler",
    'REACT_RENDER_PROFILE_MEASURE_PREFIX = "fullmag.react.render."',
    "shouldEnableReactRenderProfiler",
    "window.__FULLMAG_REACT_PROFILER__",
    "performanceTarget.measure(",
    "duration: actualDuration",
  ]);
  requireTokens(shell, "WorkspaceDockLayout React profiler", [
    "WorkspaceRenderProfiler",
    'id="WorkspaceDockLayout"',
  ]);
  requireTokens(ribbon, "RibbonModule React profiler", [
    "WorkspaceRenderProfiler",
    'id="RibbonModule"',
  ]);
  requireTokens(explorer, "ExplorerModule React profiler", [
    "WorkspaceRenderProfiler",
    'id="ExplorerModule"',
  ]);
  requireTokens(viewport, "Viewport3DModule React profiler", [
    "WorkspaceRenderProfiler",
    'id="Viewport3DModule"',
  ]);
  requireTokens(footer, "FooterModule React profiler", [
    "WorkspaceRenderProfiler",
    'id="FooterModule"',
  ]);
  requireTokens(smoke, "viewport smoke React render metrics", [
    "REACT_RENDER_MEASURE_NAMES",
    "window.__FULLMAG_REACT_PROFILER__ = true",
    "fullmag.react.render.RibbonModule",
    "fullmag.react.render.ExplorerModule",
    "fullmag.react.render.Viewport3DModule",
    "fullmag.react.render.FooterModule",
    "fullmag.react.render.WorkspaceDockLayout",
    "reactRenderMeasureCount",
    "reactRenderMeasureTotals",
  ]);
}

function checkVisualizationPatchHotPath() {
  const source = readFileSync(visualizationSyncControllerPath, "utf8");
  const objectVisualizationController = readFileSync(
    objectVisualizationControllerPath,
    "utf8",
  );
  const queuePatch = blockBetween(
    source,
    "  queuePatch(patch: VisualizationStatePatch): void {",
    "  start(): void {",
  );
  const samePatchStart = objectVisualizationController.indexOf("function samePatch");
  if (samePatchStart === -1) {
    failures.push("Could not find ObjectVisualizationController.samePatch.");
  }
  const samePatch =
    samePatchStart === -1 ? "" : objectVisualizationController.slice(samePatchStart);

  forbidTokens(source, "VisualizationRegistrySyncController sync hot path", [
    "deepMerge",
    "cloneJson",
    "stableJson",
    "JSON.stringify",
    "sortJson",
  ]);
  requireTokens(queuePatch, "VisualizationRegistrySyncController.queuePatch", [
    "visualizationPatchSatisfiesPatch",
    "mergeQueuedVisualizationPatch",
    "pendingFingerprint: null",
  ]);
  forbidTokens(queuePatch, "VisualizationRegistrySyncController.queuePatch", [
    "mergeVisualizationStatePatch",
    "fingerprintVisualizationPatch",
    "stableJson",
    "JSON.stringify",
    "sortJson",
  ]);
  const queuedMerge = blockBetween(
    source,
    "function mergeQueuedVisualizationPatch",
    "function mergeVisualizationStatePatch",
  );
  requireTokens(queuedMerge, "VisualizationRegistrySyncController queued merge", [
    "mergeQueuedPatchRecords",
    "isPlainObject(previous) && isPlainObject(value)",
  ]);
  forbidTokens(queuedMerge, "VisualizationRegistrySyncController queued merge", [
    "deepMerge",
    "cloneJson",
    "stableJson",
    "JSON.stringify",
  ]);
  requireTokens(samePatch, "ObjectVisualizationController.samePatch", [
    "Object.is",
    "Object.prototype.hasOwnProperty.call",
  ]);
  forbidTokens(samePatch, "ObjectVisualizationController.samePatch", [
    "JSON.stringify",
  ]);
}

function checkRibbonSliderCommandDebounce() {
  const source = readFileSync(ribbonMenuRendererPath, "utf8");
  const slider = blockBetween(
    source,
    "function SliderMenuItem",
    "function useDraftSliderCommand",
  );
  const draftCommand = blockBetween(
    source,
    "function useDraftSliderCommand",
    "// ── Color picker",
  );

  requireTokens(source, "RibbonMenuRenderer slider draft", [
    "useDraftSliderCommand",
    "key={node.id}",
  ]);
  forbidTokens(source, "RibbonMenuRenderer slider draft", [
    "const SLIDER_COMMAND_DEBOUNCE_MS",
    "useDebouncedSliderCommand",
    "setTimeout(flushSliderCommand",
  ]);
  requireTokens(slider, "SliderMenuItem local draft", [
    "const [draftState, setDraftState] = useState<",
    "draftState?.sourceValue === node.value ? draftState.value : node.value",
    "value={draftValue}",
    "setDraftState({ sourceValue: node.value, value: next })",
    "stageSliderCommand(next)",
    "onPointerUp={flushSliderCommand}",
    "onPointerCancel={flushSliderCommand}",
    "onBlur={flushSliderCommand}",
    "onKeyUp={flushSliderCommand}",
  ]);
  requireTokens(draftCommand, "useDraftSliderCommand", [
    "dirtyRef.current = true",
    "latestValueRef.current = value",
    "emitSliderCommand(value)",
    "dirtyRef.current = false",
  ]);
}

function checkViewportPerformanceMarks() {
  const source = readFileSync(viewportSceneModelPath, "utf8");
  requireTokens(source, "useViewport3DSceneModel performance marks", [
    "measureViewport3DModelBuild",
    "performanceTarget.mark(startMark)",
    "performanceTarget.measure(name, startMark, endMark)",
    "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
    "fullmag.viewport3d.buildMeshQualityVertexColors",
    "fullmag.viewport3d.buildViewport3DFieldRenderModel",
  ]);
  requireTokens(source, "useViewport3DSceneModel FDM build-engine path", [
    "buildViewport3DFdmCuboidJobKey",
    "useFdmCuboidBuildResult",
  ]);
}

function checkPrimitiveGeometryKeyHotPath() {
  const source = readFileSync(primitiveModelPath, "utf8");
  requireTokens(source, "viewport3dPrimitiveModel geometry key", [
    "function primitiveKeyValue",
    "function quotePrimitiveKeyString",
    "geometryKey(objectId, geometry, transform)",
  ]);
  forbidTokens(source, "viewport3dPrimitiveModel geometry key", [
    "JSON.stringify",
  ]);
}

function checkTopologyPositionConversionCache() {
  const source = readFileSync(topologyRenderModelPath, "utf8");
  const buildTopologyPositions = blockBetween(
    source,
    "function buildTopologyPositions",
    "export function buildViewport3DTopologyRenderModel",
  );

  requireTokens(source, "viewport3dRenderModel topology position cache", [
    "const topologyPositionCache = new WeakMap<DecodedTopology, Float32Array>()",
    "topologyPositionCache.get(topology)",
    "topologyPositionCache.set(topology, positions)",
  ]);
  requireTokens(buildTopologyPositions, "buildTopologyPositions", [
    "Float32Array.from(topology.positions)",
  ]);
}

function checkTopologyIndexBufferCache() {
  const source = readFileSync(topologyRenderModelPath, "utf8");
  const buildCachedSurfaceIndices = blockBetween(
    source,
    "function buildCachedTopologySurfaceIndices",
    "function buildCachedTopologyVolumeEdgeIndices",
  );
  const buildCachedVolumeEdgeIndices = blockBetween(
    source,
    "function buildCachedTopologyVolumeEdgeIndices",
    "export function buildViewport3DTopologyRenderModel",
  );

  requireTokens(source, "viewport3dRenderModel topology index buffer cache", [
    "const topologySurfaceIndexCache = new WeakMap<DecodedTopology, Uint32Array>()",
    "const topologyVolumeEdgeIndexCache = new WeakMap<DecodedTopology, Uint32Array>()",
    "buildCachedTopologySurfaceIndices(topology)",
    "buildCachedTopologyVolumeEdgeIndices(topology)",
  ]);
  requireTokens(
    buildCachedSurfaceIndices,
    "buildCachedTopologySurfaceIndices",
    [
      "topologySurfaceIndexCache.get(topology)",
      "buildTetraSurfaceIndices(topology.indices)",
      "topologySurfaceIndexCache.set(topology, surfaceIndices)",
    ],
  );
  requireTokens(
    buildCachedVolumeEdgeIndices,
    "buildCachedTopologyVolumeEdgeIndices",
    [
      "topologyVolumeEdgeIndexCache.get(topology)",
      "buildTetraVolumeEdgeIndices(topology.indices)",
      "topologyVolumeEdgeIndexCache.set(topology, volumeEdgeIndices)",
    ],
  );
  requireTokens(source, "viewport3dRenderModel per-part topology index cache", [
    "const partSurfaceIndexCache = new WeakMap",
    "const partVolumeEdgeIndexCache = new WeakMap",
    "const surfaceEdgeIndexCache = new WeakMap<Uint32Array, Uint32Array | null>()",
    "function getCachedPartTopologyValue",
    "function lazyValue",
    "buildPartSurfaceIndicesUncached(part, topology)",
    "buildPartVolumeEdgeIndicesUncached(part, topology)",
    "buildCachedSurfaceEdgeIndices(surfaceIndices())",
  ]);
}

function checkVectorSurfaceNormalCache() {
  const source = readFileSync(topologyRenderModelPath, "utf8");
  requireTokens(source, "viewport3dRenderModel vector surface normal cache", [
    "const surfaceNodeNormalCache = new WeakMap",
    "function cachedAveragedSurfaceNodeNormals",
    "surfaceNodeNormalCache.get(topology)",
    "surfaceNodeNormalCache.set(topology, normalCache)",
    "normalCache.has(cacheKey)",
    "buildAveragedSurfaceNodeNormals(topology, triangleIndices)",
  ]);
  forbidTokens(source, "viewport3dRenderModel vector surface normal cache", [
    `? buildAveragedSurfaceNodeNormals(
          topology,
          options.surfaceTriangleIndices,
        )`,
  ]);
}

function checkMeshQualityVertexColorCache() {
  const source = readFileSync(qualityMappingPath, "utf8");
  requireTokens(source, "viewport3dQualityMapping color cache", [
    "const meshQualityVertexColorCache = new WeakMap",
    "const cacheKey = `${metric}:${palette}`;",
    "cachedMeshQualityVertexColors(topology, quality, cacheKey)",
    "cacheMeshQualityVertexColors(topology, quality, cacheKey",
    "WeakMap<DecodedMeshQualityData",
  ]);
}

function checkFdmCuboidChunkedUpload() {
  const source = readFileSync(fdmCuboidLayerPath, "utf8");
  requireTokens(source, "FdmCuboidLayer chunked upload", [
    "export const FDM_CUBOID_UPLOAD_BATCH_SIZE",
    "export function buildFdmCuboidUploadBatches",
    "requestFdmUploadTask",
    "cancelFdmUploadTask",
    "fullmag.viewport3d.uploadFdmCuboidMatrices",
    "fullmag.viewport3d.uploadFdmCuboidColors",
    "mesh.setMatrixAt(index, matrix)",
    "mesh.setColorAt(index, color)",
  ]);
  forbidTokens(source, "FdmCuboidLayer chunked upload", [
    `for (let index = 0; index < model.count; index += 1) {
          const offset = index * 3;
          position.set(`,
    `for (let index = 0; index < model.count; index += 1) {
      const offset = index * 3;
      color.setRGB(`,
  ]);
}

function checkVectorGlyphChunkedUpload() {
  const source = readFileSync(vectorFieldLayerPath, "utf8");
  requireTokens(source, "VectorFieldLayer chunked upload", [
    "const VECTOR_GLYPH_UPLOAD_BATCH_SIZE",
    "function buildVectorGlyphUploadBatches",
    "createViewport3DGpuUploadManager",
    "uploadManager.enqueue",
    "AbortController",
    "onVisible: () =>",
    "const batches = buildVectorGlyphUploadBatches(activeGlyphs.count)",
    "for (let index = batch.start; index < batch.end; index += 1)",
    "activeShaft.setMatrixAt(index, matrix)",
    "activeHead.setMatrixAt(index, matrix)",
    "fullmag.viewport3d.buildVectorGlyphInstances",
    "fullmag.viewport3d.uploadVectorGlyphColors",
    "fullmag.viewport3d.uploadVectorGlyphMatrices",
  ]);
  forbidTokens(source, "VectorFieldLayer chunked upload", [
    "function requestVectorGlyphUploadTask",
    "function cancelVectorGlyphUploadTask",
    "for (let index = 0; index < glyphs.count; index += 1)",
  ]);
}

function checkFdmVectorSegmentCache() {
  const source = readFileSync(fdmCuboidLayerPath, "utf8");
  const buildSegments = blockBetween(
    source,
    "export function buildFdmVectorSegments",
    "interface FdmInspectProjectionFallbackInput",
  );

  requireTokens(source, "FdmCuboidLayer vector segment cache", [
    "const fdmVectorSegmentCache = new WeakMap",
    "function cachedFdmVectorSegments",
    "function cacheFdmVectorSegments",
    "FdmVectorSegmentCache",
  ]);
  requireTokens(buildSegments, "buildFdmVectorSegments cache lookup", [
    "const cacheKey = `${scale}:${maxVectors}:${anchorMode}`",
    "cachedFdmVectorSegments(model, fieldVector, cacheKey)",
    "if (cachedSegments !== undefined) return cachedSegments",
    "cacheFdmVectorSegments(model, fieldVector, cacheKey",
  ]);
}

function checkFdmCuboidSceneModelReuse() {
  const layerSource = readFileSync(fdmCuboidLayerPath, "utf8");
  const sceneSource = readFileSync(
    path.join(appRoot, "src/modules/viewport-3d/layers/Viewport3DScene.tsx"),
    "utf8",
  );
  const sceneModelSource = readFileSync(viewportSceneModelPath, "utf8");

  requireTokens(sceneModelSource, "useViewport3DSceneModel FDM model reuse", [
    "const fdmInstanceModelEnabled = Boolean(",
    "const fdmInstanceModelNeedsFieldVector =",
    "const fdmInstanceModelFieldVector = fdmInstanceModelNeedsFieldVector",
    "buildViewport3DFdmCuboidJobKey",
    "useFdmCuboidBuildResult",
    "modelFieldVector: fdmInstanceModelFieldVector",
    "fdmVectorSegments",
    "fdmInstanceModel?.cellIndices",
    "fdmInstanceModel: fdmInstanceModel",
  ]);
  forbidTokens(sceneModelSource, "useViewport3DSceneModel FDM model reuse", [
    "const fdmInstanceModel = useMemo",
    "buildFdmCuboidInstanceModel(",
  ]);
  forbidTokens(sceneModelSource, "useViewport3DSceneModel FDM model reuse", [
    "const fdmSurfaceInstanceModel",
    "fdmInstanceModel: fdmSurfaceInstanceModel",
  ]);
  requireTokens(sceneSource, "Viewport3DScene FDM model reuse", [
    "fdmInstanceModel: FdmCuboidInstanceModel | null | undefined",
    "fdmVectorSegments: Float32Array | null",
    "instanceModel={fdmInstanceModel}",
    "vectorSegments={fdmVectorSegments}",
  ]);
  requireTokens(layerSource, "FdmCuboidLayer precomputed instance model", [
    "instanceModel?: FdmCuboidInstanceModel | null",
    "const model = instanceModel ?? null",
  ]);
  forbidTokens(layerSource, "FdmCuboidLayer precomputed instance model", [
    "instanceModel !== undefined",
  ]);
}

function checkFooterTelemetryIsOptIn() {
  const source = readFileSync(footerModulePath, "utf8");
  requireTokens(source, "Footer telemetry opt-in", [
    'useState<FooterTabId>("telemetry")',
    'activeTab === "telemetry" ?',
    '<FooterTelemetry bus={kernel.bus} />',
  ]);
  forbidTokens(source, "Footer telemetry opt-in", [
    'useState<FooterTabId>("logs")',
  ]);

  const telemetrySource = readFileSync(footerTelemetryPath, "utf8");
  requireTokens(telemetrySource, "FooterTelemetry selective session status", [
    "selectFooterTelemetryStatus",
    "footerTelemetryStatusEquals",
    "useSessionStatusSelector(selectFooterTelemetryStatus",
    "isEqual: footerTelemetryStatusEquals",
  ]);
  forbidTokens(telemetrySource, "FooterTelemetry selective session status", [
    "(sessionStatus) => sessionStatus.data",
  ]);
}

function checkViewportSmokeComputeMetrics() {
  const source = readFileSync(viewportSmokePath, "utf8");
  requireTokens(source, "viewport smoke compute metrics", [
    "installComputePerformanceProbe",
    "collectComputePerformanceProbe",
    "PerformanceObserver",
    '"longtask"',
    "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
    "fullmag.viewport3d.buildViewport3DFieldRenderModel",
    "fullmag.viewport3d.buildVectorGlyphInstances",
    "fullmag.viewport3d.uploadVectorGlyphColors",
    "fullmag.viewport3d.uploadVectorGlyphMatrices",
    "compute_metrics",
    "sessionRequestCount",
    "maxLongTaskMs",
  ]);
}

function checkComputePerformanceMicrobenchCoverage() {
  const source = readFileSync(computePerformanceMicrobenchPath, "utf8");
  requireTokens(source, "compute performance microbench", [
    "makeLargeTopologyBuffer",
    "makeLargeQualityBuffer",
    "makeLargeVectorField",
    "assertUnderBudget",
    "decodeTopology(makeLargeTopologyBuffer",
    "decodeMeshQualityData(makeLargeQualityBuffer",
    "buildVertexScalarColorsChunked(makeLargeVectorField",
  ]);
}

function checkAnalysisPlotsStableResourceInputs() {
  const moduleSource = readFileSync(analysisPlotsModulePath, "utf8");
  const controllerSource = readFileSync(analysisPlotsControllerPath, "utf8");
  const modelSource = readFileSync(analysisPlotsModelPath, "utf8");
  const viewSource = readFileSync(analysisPlotsViewPath, "utf8");
  const adapterSource = readFileSync(analysisTableRowsAdapterPath, "utf8");
  const chartTableSource = readFileSync(chartTableModelPath, "utf8");
  requireTokens(moduleSource, "analysis plots stable resource inputs", [
    "useAnalysisPlotsController(kernel)",
    "AnalysisPlotsView",
    "onRangeChange={controller.setRange}",
    "visibleTable={controller.visibleTable}",
    "xAxisId={controller.xAxisId}",
    "yAxisIds={controller.yAxisIds}",
  ]);
  requireTokens(controllerSource, "analysis plots stable resource inputs", [
    "useTableColumnsResource",
    "useTableRowsBinaryResource",
    "tableRowsResourceFromBinary",
    "buildAnalysisPlotsTableQuery({ cursor, range, xAxisId })",
    "shouldFetchAnalysisTableRows({",
  ]);
  requireTokens(modelSource, "analysis plots stable resource inputs", [
    "columns: ANALYSIS_SCALAR_COLUMNS",
    "targetPoints: 1_600",
  ]);
  requireTokens(viewSource, "analysis plots stable resource inputs", [
    "const table = useMemo<TableRowsLike | null>(",
    "buildScalarChartSeries(table,",
    "const chartSeries = useMemo(",
    "onRangeChange={onRangeChange}",
    "series={chartSeries}",
    "xAxisLabel={xAxisLabel}",
  ]);
  requireTokens(adapterSource, "analysis plots table rows adapter", [
    "ANALYSIS_SCALAR_COLUMNS",
    "mergeTableRows",
    "MAX_VISIBLE_TABLE_ROWS",
    "tableRowsResourceFromBinary",
    "tableRowsResourceFromScalarSample",
  ]);
  requireTokens(chartTableSource, "analysis plots chart table model", [
    "export interface ChartSeries",
    "DEFAULT_TABLE_CHART_COLUMNS",
    "buildScalarChartSeries",
    "buildTableRowsQuery",
  ]);
  forbidTokens(
    [moduleSource, controllerSource, modelSource].join("\n"),
    "analysis plots stable resource inputs",
    [
      "useTableRowsResource(",
      'columns: ["step", "e_total", "mx", "my", "mz"]',
      "buildLineChartModel(points)",
    ],
  );
}

function checkAnalysisPlotDecimation() {
  const source = readFileSync(chartTableModelPath, "utf8");
  const testSource = readFileSync(
    path.join(appRoot, "src/modules/analysis-plots/chartTableModel.test.ts"),
    "utf8",
  );
  requireTokens(source, "analysis plot decimation", [
    'decimation: "minmax_lttb"',
    "targetPoints: clampInteger(",
    "targetPoints ?? 1_600",
    "MIN_TARGET_POINTS",
    "MAX_TARGET_POINTS",
    "DEFAULT_TABLE_ROW_LIMIT",
    "buildScalarChartSeries",
    "Number.isFinite(x) && Number.isFinite(y)",
  ]);
  requireTokens(testSource, "analysis plot decimation", [
    "decimation: \"minmax_lttb\"",
    "targetPoints: 1_600",
    "targetPoints: 800",
    "drops non-finite chart points while preserving finite extrema",
  ]);
  forbidTokens(source, "analysis plot decimation", [
    "buildLineChartModel",
    "MAX_LINE_CHART_POINTS",
    "decimateLinePoints",
  ]);
}

function checkComputePerformanceSmokeScript() {
  const source = readFileSync(computePerformanceSmokePath, "utf8");
  requireTokens(source, "compute performance smoke", [
    "STRICT_COMPUTE_ACTIONS",
    '"study.compute-fields"',
    '"study.compute-energies"',
    '"study.run"',
    "window.__FULLMAG_REACT_PROFILER__ = true",
    'observePerformanceEntries("longtask"',
    'observePerformanceEntries("measure"',
    "waitForEnabledAction",
    "clickComputeAction",
    "waitForCommandSettled",
    "TERMINAL_COMMAND_STATUSES",
    "cleanupSolveCommand",
    "commandRequestCount",
    "commandResponseCount",
    "FORBIDDEN_ACCEPTANCE_RESOURCE_PATHS",
    "assertNoImmediateResultResourceReloads",
    "COMPUTE_VIEWPORT_GESTURE_FORBIDDEN_REQUEST_PREFIXES",
    "verifyViewport3DGesturesDuringSolve",
    "viewportGestureProof",
    "recordViewportGestureRequests",
    "previousCameraSignature",
    "nextCameraSignature = await waitForCameraSignatureChange(",
    "return nextCameraSignature;",
    "resultResourceRequestCount",
    "isForbiddenAcceptanceResourceUrl",
    "/v2/sessions/current/data/fields",
    "/v2/sessions/current/data/scalars",
    "/v2/sessions/current/simulation/solver/energies/current",
    "/v2/sessions/current/simulation/solver/energies/history",
    "simulation\\/objects\\/[^/]+\\/metrics",
    "COMPUTE_RESPONSIVENESS_PROBE_INTERVAL_MS",
    "startResponsivenessProbe",
    "maxResponsivenessDelayMs",
    "totalResponsivenessDelayMs",
    "delayedResponsivenessTickCount",
    "reactRenderMeasureTotals",
    "BINARY_RESOURCE_MEASURE_NAMES",
    "fullmag.api.requestBinaryResource.topology",
    "fullmag.api.requestBinaryResource.topology.transport",
    "fullmag.api.requestBinaryResource.topology.decode",
    "fullmag.api.requestBinaryResource.mesh-quality-data",
    "fullmag.api.requestBinaryResource.mesh-quality-data.transport",
    "fullmag.api.requestBinaryResource.mesh-quality-data.decode",
    "fullmag.api.requestBinaryResource.field-vector",
    "fullmag.api.requestBinaryResource.field-vector.transport",
    "fullmag.api.requestBinaryResource.field-vector.decode",
    "binaryResourceMeasureCount",
    "binaryResourceMeasureTotals",
    'startsWith("fullmag.api.requestBinaryResource.")',
    'startsWith("fullmag.viewport3d.")',
    "viewportMeasureTotals",
  ]);
}

function blockBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  if (start === -1) {
    failures.push(`Could not find start marker: ${startNeedle}`);
    return "";
  }

  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end === -1) {
    failures.push(`Could not find end marker after ${startNeedle}: ${endNeedle}`);
    return source.slice(start);
  }

  return source.slice(start, end);
}

function relativeAppPath(filePath) {
  return path.relative(appRoot, filePath).split(path.sep).join("/");
}

function requireTokens(block, label, tokens) {
  for (const token of tokens) {
    if (!block.includes(token)) {
      failures.push(`${label} must include ${token}.`);
    }
  }
}

function requirePatterns(block, label, patterns) {
  for (const [pattern, description] of patterns) {
    if (!pattern.test(block)) {
      failures.push(`${label} must match ${description}.`);
    }
  }
}

function forbidTokens(block, label, tokens) {
  for (const token of tokens) {
    if (block.includes(token)) {
      failures.push(`${label} must not include ${token}.`);
    }
  }
}

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
const footerModulePath = path.join(
  appRoot,
  "src/modules/footer/FooterModule.tsx",
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
const reactRenderProfilerPath = path.join(
  appRoot,
  "src/kernel/performance/reactRenderProfiler.tsx",
);
const footerModelPath = path.join(
  appRoot,
  "src/modules/footer/footerModel.ts",
);
const useLayoutPath = path.join(appRoot, "src/kernel/layout/useLayout.ts");
const useSelectionPath = path.join(
  appRoot,
  "src/kernel/selection/useSelection.ts",
);
const explorerStorePath = path.join(
  appRoot,
  "src/modules/explorer/explorerStore.ts",
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
const viewportSmokePath = path.join(
  appRoot,
  "scripts/smoke-viewport-3d.mjs",
);
const computePerformanceSmokePath = path.join(
  appRoot,
  "scripts/smoke-compute-performance.mjs",
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
].map((contract) => ({
  ...contract,
  absolutePath: path.join(appRoot, contract.path),
}));
const viewportSceneModelPath = path.join(
  appRoot,
  "src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts",
);
const fdmCuboidLayerPath = path.join(
  appRoot,
  "src/modules/viewport-3d/layers/FdmCuboidLayer.tsx",
);
const binaryResourcePerformanceMeasureNames = [
  "fullmag.api.requestBinaryResource.topology",
  "fullmag.api.requestBinaryResource.mesh-quality-data",
  "fullmag.api.requestBinaryResource.field-vector",
];

const failures = [];

checkComputeCommandInvalidationScope();
checkRealtimeSessionStatusFanout();
checkBinaryDecodeScheduler();
checkControlRoomApiBinaryPerformanceMarks();
checkSessionStatusSelectors();
checkShellSelectorHooks();
checkCommandShortcutConnector();
checkFooterDiagnosticsBatching();
checkPerformanceDiagnosticsExport();
checkReactRenderProfilerInstrumentation();
checkVisualizationPatchHotPath();
checkViewportPerformanceMarks();
checkFdmCuboidChunkedUpload();
checkFooterTelemetryIsOptIn();
checkViewportSmokeComputeMetrics();
checkComputePerformanceSmokeScript();

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
    requireTokens(block, label, ["invalidateRuntimeControlResources"]);
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
  ]);

  for (const measureName of binaryResourcePerformanceMeasureNames) {
    const decoderKind = measureName.replace(
      "fullmag.api.requestBinaryResource.",
      "",
    );
    if (!controlRoomApi.includes(`"${decoderKind}"`)) {
      failures.push(
        `ControlRoomApi binary performance marks must cover ${measureName}.`,
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

function checkShellSelectorHooks() {
  const useLayout = readFileSync(useLayoutPath, "utf8");
  const useSelection = readFileSync(useSelectionPath, "utf8");
  const explorerStore = readFileSync(explorerStorePath, "utf8");
  const objectVisualization = readFileSync(objectVisualizationHookPath, "utf8");

  requireTokens(useLayout, "useLayout selector hooks", [
    "export function useLayoutSelector",
    "export function useLayoutActions",
  ]);
  requireTokens(useSelection, "useSelection selector hook", [
    "export function useSelectionSelector",
  ]);
  requireTokens(explorerStore, "explorer store selector hook", [
    "export function useExplorerStoreSelector",
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
      "private notificationQueued = false",
      "listNewestFirst()",
      "private schedulePublish(): void",
      "queueMicrotask(() => {",
    ]);
    forbidTokens(source, label, [
      "private publish(): void",
    ]);
  }
}

function checkPerformanceDiagnosticsExport() {
  const performanceDiagnostics = readFileSync(
    performanceMeasureDiagnosticsPath,
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
    "startPerformanceMeasureDiagnostics({ diagnostics: kernel.diagnostics })",
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
  requireTokens(smoke, "viewport smoke React render metrics", [
    "REACT_RENDER_MEASURE_NAMES",
    "window.__FULLMAG_REACT_PROFILER__ = true",
    "fullmag.react.render.RibbonModule",
    "fullmag.react.render.ExplorerModule",
    "fullmag.react.render.Viewport3DModule",
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

  requireTokens(queuePatch, "VisualizationRegistrySyncController.queuePatch", [
    "visualizationPatchSatisfiesPatch",
    "pendingFingerprint: null",
  ]);
  forbidTokens(queuePatch, "VisualizationRegistrySyncController.queuePatch", [
    "fingerprintVisualizationPatch",
    "stableJson",
    "JSON.stringify",
    "sortJson",
  ]);
  requireTokens(samePatch, "ObjectVisualizationController.samePatch", [
    "Object.is",
    "Object.prototype.hasOwnProperty.call",
  ]);
  forbidTokens(samePatch, "ObjectVisualizationController.samePatch", [
    "JSON.stringify",
  ]);
}

function checkViewportPerformanceMarks() {
  const source = readFileSync(viewportSceneModelPath, "utf8");
  requireTokens(source, "useViewport3DSceneModel performance marks", [
    "measureViewport3DModelBuild",
    "performanceTarget.mark(startMark)",
    "performanceTarget.measure(name, startMark, endMark)",
    "fullmag.viewport3d.buildTopologyRenderModel",
    "fullmag.viewport3d.buildMeshQualityVertexColors",
    "fullmag.viewport3d.buildFdmCuboidInstanceModel",
    "fullmag.viewport3d.buildFieldRenderModel",
  ]);
}

function checkFdmCuboidChunkedUpload() {
  const source = readFileSync(fdmCuboidLayerPath, "utf8");
  requireTokens(source, "FdmCuboidLayer chunked upload", [
    "export const FDM_CUBOID_UPLOAD_BATCH_SIZE",
    "export function buildFdmCuboidUploadBatches",
    "requestFdmUploadFrame",
    "cancelFdmUploadFrame",
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

function checkFooterTelemetryIsOptIn() {
  const source = readFileSync(footerModulePath, "utf8");
  requireTokens(source, "Footer telemetry opt-in", [
    'useState<FooterTabId>("logs")',
    'activeTab === "telemetry" ? <FooterTelemetry /> : null',
  ]);
  forbidTokens(source, "Footer telemetry opt-in", [
    'useState<FooterTabId>("telemetry")',
  ]);
}

function checkViewportSmokeComputeMetrics() {
  const source = readFileSync(viewportSmokePath, "utf8");
  requireTokens(source, "viewport smoke compute metrics", [
    "installComputePerformanceProbe",
    "collectComputePerformanceProbe",
    "PerformanceObserver",
    '"longtask"',
    "fullmag.viewport3d.buildTopologyRenderModel",
    "fullmag.viewport3d.buildFdmCuboidInstanceModel",
    "fullmag.viewport3d.buildFieldRenderModel",
    "compute_metrics",
    "sessionRequestCount",
    "maxLongTaskMs",
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
    "reactRenderMeasureTotals",
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

function forbidTokens(block, label, tokens) {
  for (const token of tokens) {
    if (block.includes(token)) {
      failures.push(`${label} must not include ${token}.`);
    }
  }
}

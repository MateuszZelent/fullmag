"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { SESSION_EVENTS_WS_PATH } from "./api/apiPaths";
import {
  createBinaryDecodeScheduler,
  type BinaryDecodeDiagnosticEvent,
} from "./api/binaryDecodeScheduler";
import { ControlRoomApi } from "./api/ControlRoomApi";
import {
  resolveControlRoomApiBase,
  resolveControlRoomWebSocketUrl,
} from "./api/apiRuntimeTarget";
import { normalizeQuantityIdOrDefault } from "./api/quantityIds";
import { RequestDiagnosticsController } from "./api/RequestDiagnosticsController";
import { GEOMETRY_LIFECYCLE_COMMANDS } from "./authoring/geometryLifecycleCommandContributions";
import { MAGNETIZATION_TEXTURE_COMMANDS } from "./authoring/magnetization-texture/commands";
import { REGION_COMMANDS } from "./authoring/regionCommandContributions";
import { createCommandContext } from "./commands/commandContext";
import { CommandRegistry } from "./commands/CommandRegistry";
import {
  dispatchShortcutCommand,
} from "./commands/commandShortcuts";
import { CommandDiagnosticsController } from "./commands/CommandDiagnosticsController";
import { EventBus } from "./events/EventBus";
import type { KernelEventMap } from "./events/eventTypes";
import {
  performanceDiagnosticsEnabledFromBrowserConfig,
  type BrowserFullmagConfig,
} from "./browserFullmagConfig";
import {
  DIAGNOSTIC_EVENT_NAMES,
  DiagnosticRecorderController,
} from "./performance/diagnostic-recorder/DiagnosticRecorderController";
import { recordDiagnosticBrowserSnapshot } from "./performance/diagnostic-recorder/diagnosticBrowserSnapshot";
import { installDiagnosticConsoleCapture } from "./performance/diagnostic-recorder/diagnosticConsoleCapture";
import { resolveDiagnosticRecorderConfig } from "./performance/diagnostic-recorder/diagnosticRecorderConfig";
import { KernelContext } from "./KernelContext";
import { LayoutController } from "./layout/LayoutController";
import { SHELL_COMMANDS } from "./layout/shellCommands";
import { ModuleRegistry } from "./module/ModuleRegistry";
import { startBrowserActivityDiagnostics } from "./performance/browserActivityDiagnostics";
import { startPerformanceMeasureDiagnostics } from "./performance/performanceMeasureDiagnostics";
import { installPerformanceMeasureGuard } from "./performance/performanceMeasureGuard";
import { RealtimeClient } from "./realtime/RealtimeClient";
import { RealtimeInvalidationBridge } from "./realtime/RealtimeInvalidationBridge";
import { useSimulationStartupOverlayVisibility } from "./layout/SimulationStartupOverlay";
import { ResourceInvalidationController } from "./resources/ResourceInvalidationController";
import { useRuntimeCommandControlResourceData } from "./resources/studyRuntimeResources";
import { STUDY_RUNTIME_COMMANDS } from "./runtime/studyRuntimeCommandContributions";
import { SelectionController } from "./selection/SelectionController";
import type { KernelApi } from "./types";
import { CameraRegistryController } from "./visualization/CameraRegistryController";
import { AnalysisFieldOverlayController } from "./visualization/AnalysisFieldOverlayController";
import { ANALYSIS_FIELD_OVERLAY_COMMANDS } from "./visualization/analysisFieldOverlayCommandContributions";
import { ObjectVisualizationController } from "./visualization/ObjectVisualizationController";
import { VisualizationRegistrySyncController } from "./visualization/VisualizationRegistrySyncController";
import { VISUALIZATION_TARGET_COMMANDS } from "./visualization/visualizationCommandContributions";
import { resolveControlRoomModules } from "@/modules";

installPerformanceMeasureGuard();

interface KernelProviderProps {
  children: ReactNode;
}

function createKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const diagnostics = new RequestDiagnosticsController();
  const browserConfig =
    typeof window === "undefined"
      ? undefined
      : (window as Window & { __FULLMAG_CONFIG__?: BrowserFullmagConfig })
          .__FULLMAG_CONFIG__;
  const diagnosticRecorder = new DiagnosticRecorderController({
    config: resolveDiagnosticRecorderConfig(browserConfig),
    diagnostics,
  });
  diagnosticRecorder.mark(DIAGNOSTIC_EVENT_NAMES.kernelCreated);
  const commandDiagnostics = new CommandDiagnosticsController();
  const binaryDecodeScheduler = createBinaryDecodeScheduler({
    onEvent: (event) => {
      recordBinaryDecodeDiagnostic(diagnosticRecorder, event);
    },
  });
  const api = new ControlRoomApi({
    baseUrl: resolveControlRoomApiBase(),
    binaryDecodeScheduler,
    diagnostics,
  });
  const commands = new CommandRegistry();
  commands.attach(bus);
  commands.attachDiagnostics(commandDiagnostics);

  const modules = new ModuleRegistry();
  const resources = new ResourceInvalidationController(bus);
  const selection = new SelectionController(bus);
  const layout = new LayoutController(bus);
  const cameraRegistry = new CameraRegistryController({
    api: api.visualization,
  });
  const analysisFieldOverlay = new AnalysisFieldOverlayController();
  const visualization = new ObjectVisualizationController();
  const visualizationSync = new VisualizationRegistrySyncController({
    api: api.visualization,
    resources,
  });
  const realtime = new RealtimeInvalidationBridge(resources, {
    bus,
    shouldSuppressInvalidation: (resourceKey, revision) =>
      visualizationSync.shouldSuppressInvalidation(resourceKey, revision) ||
      cameraRegistry.shouldSuppressInvalidation(resourceKey, revision),
  });

  for (const cmd of SHELL_COMMANDS) {
    commands.register(cmd);
  }
  for (const cmd of GEOMETRY_LIFECYCLE_COMMANDS) {
    commands.register(cmd);
  }
  for (const cmd of STUDY_RUNTIME_COMMANDS) {
    commands.register(cmd);
  }
  for (const cmd of MAGNETIZATION_TEXTURE_COMMANDS) {
    commands.register(cmd);
  }
  for (const cmd of REGION_COMMANDS) {
    commands.register(cmd);
  }
  for (const cmd of VISUALIZATION_TARGET_COMMANDS) {
    commands.register(cmd);
  }
  for (const cmd of ANALYSIS_FIELD_OVERLAY_COMMANDS) {
    commands.register(cmd);
  }

  // Register modules and auto-register their contributed commands.
  for (const manifest of resolveControlRoomModules()) {
    modules.register(manifest);
    if (manifest.contributes?.commands) {
      for (const cmd of manifest.contributes.commands) {
        commands.register(cmd);
      }
    }
  }

  return {
    api,
    analysisFieldOverlay,
    bus,
    cameraRegistry,
    commandDiagnostics,
    commands,
    diagnostics,
    diagnosticRecorder,
    layout,
    modules,
    realtime,
    resources,
    selection,
    visualization,
    visualizationSync,
  };
}

function recordBinaryDecodeDiagnostic(
  diagnosticRecorder: DiagnosticRecorderController,
  event: BinaryDecodeDiagnosticEvent,
): void {
  diagnosticRecorder.record({
    byteLength: event.payloadBytes,
    detail: {
      decoderKind: event.kind,
      errorName: event.errorName,
      outcome: event.outcome,
      path: event.path,
      queueWaitMs: event.queueWaitMs,
      worker: event.worker,
    },
    droppedCount: 0,
    durationMs: event.durationMs,
    id: "",
    kind: "binary-decode",
    lane: event.worker ? "worker" : "main-thread",
    name:
      event.outcome === "ok"
        ? "binary-decode.finished"
        : "binary-decode.error",
    severity:
      event.outcome === "error" || event.durationMs >= 100
        ? "warning"
        : "info",
    startTimeMs: Math.max(0, event.timestampMs - event.durationMs),
    timestampMs: event.timestampMs,
  });
}

function DiagnosticRecorderConnector({ kernel }: { kernel: KernelApi }) {
  useEffect(() => {
    const diagnosticWindow = window as Window & {
      __FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?: () => ReturnType<
        KernelApi["diagnosticRecorder"]["exportArtifact"]
      >;
    };
    const exportDiagnosticArtifact = () =>
      kernel.diagnosticRecorder.exportArtifact();
    diagnosticWindow.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__ =
      exportDiagnosticArtifact;
    kernel.diagnosticRecorder.drainEarlyRecorder();
    recordDiagnosticBrowserSnapshot((record) => {
      kernel.diagnosticRecorder.record(record);
    });
    const cleanupConsoleCapture = installDiagnosticConsoleCapture({
      record: (record) => {
        kernel.diagnosticRecorder.record(record);
      },
    });
    kernel.diagnosticRecorder.mark(DIAGNOSTIC_EVENT_NAMES.kernelProviderMounted);
    return () => {
      if (
        diagnosticWindow.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__ ===
        exportDiagnosticArtifact
      ) {
        delete diagnosticWindow.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__;
      }
      cleanupConsoleCapture();
    };
  }, [kernel]);

  return null;
}

function RealtimeConnector({ kernel }: { kernel: KernelApi }) {
  useEffect(() => {
    if (controlRoomRealtimeDisabledFromBrowser()) {
      return;
    }

    if (typeof WebSocket === "undefined") {
      return;
    }

    const url = resolveControlRoomWebSocketUrl(
      kernel.api.getBaseUrl(),
      SESSION_EVENTS_WS_PATH,
      window.location.origin,
    );
    if (!url) {
      return;
    }

    const client = new RealtimeClient({
      bridge: kernel.realtime,
      diagnostics: kernel.diagnostics,
      url,
    });
    client.connect();
    return () => client.close();
  }, [kernel]);

  return null;
}

function controlRoomRealtimeDisabledFromBrowser(): boolean {
  const auditWindow = window as Window & {
    __FULLMAG_CONFIG__?: { disableRealtime?: boolean };
  };
  return auditWindow.__FULLMAG_CONFIG__?.disableRealtime === true;
}

function CommandShortcutConnector({ kernel }: { kernel: KernelApi }) {
  const startupVisible = useSimulationStartupOverlayVisibility();
  const runtimeResourceData = useRuntimeCommandControlResourceData({
    enabled: !startupVisible,
  });
  const runtimeResourceDataRef = useRef(runtimeResourceData);

  useEffect(() => {
    runtimeResourceDataRef.current = runtimeResourceData;
  }, [runtimeResourceData]);

  useEffect(() => {
    if (startupVisible) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      const context = createCommandContext("shortcut", kernel, {
        resourceData: runtimeResourceDataRef.current,
        sourceDetail: "global",
      });
      dispatchShortcutCommand(kernel.commands, event, context);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [kernel, startupVisible]);

  return null;
}

function VisualizationRegistrySyncConnector({ kernel }: { kernel: KernelApi }) {
  useEffect(() => {
    kernel.visualizationSync.start();
    return () => kernel.visualizationSync.stop();
  }, [kernel]);

  return null;
}

function CameraRegistrySyncConnector({ kernel }: { kernel: KernelApi }) {
  useEffect(() => {
    kernel.cameraRegistry.start();
    return () => kernel.cameraRegistry.stop();
  }, [kernel]);

  return null;
}

function BrowserAuditConnector({ kernel }: { kernel: KernelApi }) {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const auditWindow = window as Window & {
      __FULLMAG_CONFIG__?: {
        allowMissingSessionSmoke?: boolean;
        disableRealtime?: boolean;
        enableAuditHooks?: boolean;
      };
      __FULLMAG_CONTROL_ROOM_AUDIT__?: {
        loadHysteresisReplaySnapshot: (input: {
          fieldVal?: number | null;
          fieldRevision?: string | number | null;
          mVal?: number | null;
          measurementAxis?: string | null;
          meshIdentity?: string | null;
          pointId: number;
          snapshotId: string;
          stageId: string;
        }) => void;
        returnHysteresisReplayToLive: (input?: {
          stageId?: string | null;
        }) => Promise<void>;
        setGlobalQuantity: (quantityId: string) => Promise<void>;
      };
    };
    const browserConfig = auditWindow.__FULLMAG_CONFIG__;
    if (
      !browserConfig?.allowMissingSessionSmoke &&
      !browserConfig?.enableAuditHooks
    ) {
      return;
    }

    const auditApi = {
      loadHysteresisReplaySnapshot: (input: {
        fieldVal?: number | null;
        fieldRevision?: string | number | null;
        mVal?: number | null;
        measurementAxis?: string | null;
        meshIdentity?: string | null;
        pointId: number;
        snapshotId: string;
        stageId: string;
      }) => {
        const fieldVal = input.fieldVal ?? input.pointId;
        const mVal = input.mVal ?? 0;
        kernel.selection.set(
          {
            kind: "analysis.chart-point",
            label: `Point ${input.pointId} (${fieldVal} mT)`,
            nodeId: `analysis:hysteresis:${input.stageId}:point:${input.pointId}`,
            objectId: null,
            ref: {
              chartId: `hysteresis:${input.stageId}`,
              fieldRevision: input.fieldRevision ?? null,
              kind: "analysis.chart-point",
              measurementAxis: input.measurementAxis ?? null,
              meshIdentity: input.meshIdentity ?? null,
              nodeId: `analysis:hysteresis:${input.stageId}:point:${input.pointId}`,
              pointId: input.pointId,
              quantity: "m",
              quantityId: "m",
              rowIndex: input.pointId,
              seriesId: `hysteresis:${input.stageId}:m`,
              snapshotId: input.snapshotId,
              stageId: input.stageId,
              tableId: `hysteresis:${input.stageId}`,
              targetId: `hysteresis-step:${input.stageId}:${input.pointId}`,
              targetKind: "hysteresis-step",
              type: "analysis-chart-point",
              x: fieldVal,
              y: mVal,
            },
          },
          "analysis-plots",
        );
        kernel.layout.setActiveViewportMainModule("viewport-3d");
        kernel.layout.setFocusedSlot("viewport-main");
      },
      returnHysteresisReplayToLive: async (input?: {
        stageId?: string | null;
      }) => {
        await kernel.commands.execute(
          "hysteresis.return-to-live",
          createCommandContext("analysis-plots", kernel),
          { stageId: input?.stageId ?? null },
        );
      },
      setGlobalQuantity: async (quantityId: string) => {
        const activeQuantityId = normalizeQuantityIdOrDefault(quantityId);
        kernel.visualizationSync.queuePatch({
          active_quantity_id: activeQuantityId,
          quantity: { active_quantity_id: activeQuantityId },
        });
        await kernel.visualizationSync.flushNow();
      },
    };
    auditWindow.__FULLMAG_CONTROL_ROOM_AUDIT__ = auditApi;
    return () => {
      if (auditWindow.__FULLMAG_CONTROL_ROOM_AUDIT__ === auditApi) {
        delete auditWindow.__FULLMAG_CONTROL_ROOM_AUDIT__;
      }
    };
  }, [kernel]);

  return null;
}

function PerformanceDiagnosticsConnector({ kernel }: { kernel: KernelApi }) {
  useEffect(
    () => {
      if (!performanceDiagnosticsEnabledFromBrowserConfig()) {
        return;
      }
      const stopMeasures = startPerformanceMeasureDiagnostics({
        diagnostics: kernel.diagnostics,
      });
      const stopBrowserActivity = startBrowserActivityDiagnostics({
        diagnostics: kernel.diagnostics,
      });
      return () => {
        stopMeasures();
        stopBrowserActivity();
      };
    },
    [kernel.diagnostics],
  );

  return null;
}

export function KernelProvider({ children }: KernelProviderProps) {
  const kernel = useMemo(() => createKernel(), []);

  return (
    <KernelContext.Provider value={kernel}>
      <RealtimeConnector kernel={kernel} />
      <CommandShortcutConnector kernel={kernel} />
      <VisualizationRegistrySyncConnector kernel={kernel} />
      <CameraRegistrySyncConnector kernel={kernel} />
      <BrowserAuditConnector kernel={kernel} />
      <DiagnosticRecorderConnector kernel={kernel} />
      <PerformanceDiagnosticsConnector kernel={kernel} />
      {children}
    </KernelContext.Provider>
  );
}

"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { SESSION_EVENTS_WS_PATH } from "./api/apiPaths";
import { ControlRoomApi } from "./api/ControlRoomApi";
import {
  resolveControlRoomApiBase,
  resolveControlRoomWebSocketUrl,
} from "./api/apiRuntimeTarget";
import { RequestDiagnosticsController } from "./api/RequestDiagnosticsController";
import { GEOMETRY_LIFECYCLE_COMMANDS } from "./authoring/geometryLifecycleCommandContributions";
import { MAGNETIZATION_TEXTURE_COMMANDS } from "./authoring/magnetization-texture/commands";
import { createCommandContext } from "./commands/commandContext";
import { CommandRegistry } from "./commands/CommandRegistry";
import {
  dispatchShortcutCommand,
} from "./commands/commandShortcuts";
import { CommandDiagnosticsController } from "./commands/CommandDiagnosticsController";
import { EventBus } from "./events/EventBus";
import type { KernelEventMap } from "./events/eventTypes";
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
import { ObjectVisualizationController } from "./visualization/ObjectVisualizationController";
import { VisualizationRegistrySyncController } from "./visualization/VisualizationRegistrySyncController";
import { VISUALIZATION_TARGET_COMMANDS } from "./visualization/visualizationCommandContributions";
import { ALL_MODULES } from "@/modules";

installPerformanceMeasureGuard();

interface KernelProviderProps {
  children: ReactNode;
}

function createKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const diagnostics = new RequestDiagnosticsController();
  const commandDiagnostics = new CommandDiagnosticsController();
  const api = new ControlRoomApi({
    baseUrl: resolveControlRoomApiBase(),
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
  const visualization = new ObjectVisualizationController();
  const visualizationSync = new VisualizationRegistrySyncController({
    api: api.visualization,
    resources,
  });
  const realtime = new RealtimeInvalidationBridge(resources, {
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
  for (const cmd of VISUALIZATION_TARGET_COMMANDS) {
    commands.register(cmd);
  }

  // Register modules and auto-register their contributed commands.
  for (const manifest of ALL_MODULES) {
    modules.register(manifest);
    if (manifest.contributes?.commands) {
      for (const cmd of manifest.contributes.commands) {
        commands.register(cmd);
      }
    }
  }

  return {
    api,
    bus,
    cameraRegistry,
    commandDiagnostics,
    commands,
    diagnostics,
    layout,
    modules,
    realtime,
    resources,
    selection,
    visualization,
    visualizationSync,
  };
}

function RealtimeConnector({ kernel }: { kernel: KernelApi }) {
  const startupVisible = useSimulationStartupOverlayVisibility();

  useEffect(() => {
    if (controlRoomRealtimeDisabledFromBrowser()) {
      return;
    }

    if (startupVisible) {
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
  }, [kernel, startupVisible]);

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
      };
      __FULLMAG_CONTROL_ROOM_AUDIT__?: {
        setGlobalQuantity: (quantityId: string) => Promise<void>;
      };
    };
    if (!auditWindow.__FULLMAG_CONFIG__?.allowMissingSessionSmoke) {
      return;
    }

    const auditApi = {
      setGlobalQuantity: async (quantityId: string) => {
        kernel.visualizationSync.queuePatch({
          active_quantity_id: quantityId,
          quantity: { active_quantity_id: quantityId },
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
      <PerformanceDiagnosticsConnector kernel={kernel} />
      {children}
    </KernelContext.Provider>
  );
}

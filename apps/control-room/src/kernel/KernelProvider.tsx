"use client";

import { useEffect, useMemo, type ReactNode } from "react";

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
import { installPerformanceMeasureGuard } from "./performance/performanceMeasureGuard";
import { RealtimeClient } from "./realtime/RealtimeClient";
import { RealtimeInvalidationBridge } from "./realtime/RealtimeInvalidationBridge";
import { resolveSimulationStartupOverlayState } from "./layout/SimulationStartupOverlay";
import { ResourceInvalidationController } from "./resources/ResourceInvalidationController";
import { useRuntimeCommandControlResourceData } from "./resources/studyRuntimeResources";
import { useSessionStatus } from "./resources/useSessionStatus";
import { STUDY_RUNTIME_COMMANDS } from "./runtime/studyRuntimeCommandContributions";
import { SelectionController } from "./selection/SelectionController";
import type { KernelApi } from "./types";
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
  const visualization = new ObjectVisualizationController();
  const visualizationSync = new VisualizationRegistrySyncController({
    api: api.visualization,
    resources,
  });
  const realtime = new RealtimeInvalidationBridge(resources, {
    shouldSuppressInvalidation: (resourceKey, revision) =>
      visualizationSync.shouldSuppressInvalidation(resourceKey, revision),
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
  const sessionStatus = useSessionStatus();
  const startupState = resolveSimulationStartupOverlayState(sessionStatus);

  useEffect(() => {
    if (startupState.isVisible) {
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
  }, [kernel, startupState.isVisible]);

  return null;
}

function CommandShortcutConnector({ kernel }: { kernel: KernelApi }) {
  const sessionStatus = useSessionStatus();
  const startupState = resolveSimulationStartupOverlayState(sessionStatus);
  const runtimeResourceData = useRuntimeCommandControlResourceData({
    enabled: !startupState.isVisible,
  });

  useEffect(() => {
    if (startupState.isVisible) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      const context = createCommandContext("shortcut", kernel, {
        resourceData: runtimeResourceData,
        sourceDetail: "global",
      });
      dispatchShortcutCommand(kernel.commands, event, context);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [kernel, runtimeResourceData, startupState.isVisible]);

  return null;
}

function VisualizationRegistrySyncConnector({ kernel }: { kernel: KernelApi }) {
  useEffect(() => {
    kernel.visualizationSync.start();
    return () => kernel.visualizationSync.stop();
  }, [kernel]);

  return null;
}

export function KernelProvider({ children }: KernelProviderProps) {
  const kernel = useMemo(() => createKernel(), []);

  return (
    <KernelContext.Provider value={kernel}>
      <RealtimeConnector kernel={kernel} />
      <CommandShortcutConnector kernel={kernel} />
      <VisualizationRegistrySyncConnector kernel={kernel} />
      {children}
    </KernelContext.Provider>
  );
}

import type { ComponentType } from "react";

import type { ControlRoomApi } from "./api/ControlRoomApi";
import type { RequestDiagnosticsController } from "./api/RequestDiagnosticsController";
import type { CommandDiagnosticsController } from "./commands/CommandDiagnosticsController";
import type { CommandContribution } from "./commands/commandTypes";
import type { CommandRegistry } from "./commands/CommandRegistry";
import type { EventBus } from "./events/EventBus";
import type { KernelEventMap } from "./events/eventTypes";
import type { LayoutController } from "./layout/LayoutController";
import type { ModuleRegistry } from "./module/ModuleRegistry";
import type { RealtimeInvalidationBridge } from "./realtime/RealtimeInvalidationBridge";
import type { ResourceInvalidationController } from "./resources/ResourceInvalidationController";
import type { SelectionController } from "./selection/SelectionController";
import type { DiagnosticRecorderController } from "./performance/diagnostic-recorder/DiagnosticRecorderController";
import type { AnalysisFieldOverlayController } from "./visualization/AnalysisFieldOverlayController";
import type { CameraRegistryController } from "./visualization/CameraRegistryController";
import type { ObjectVisualizationController } from "./visualization/ObjectVisualizationController";
import type { VisualizationDebugController } from "./visualization/VisualizationDebugController";
import type { VisualizationRegistrySyncController } from "./visualization/VisualizationRegistrySyncController";

export type SlotId =
  | "app-menu"
  | "ribbon"
  | "panel-left"
  | "viewport-main"
  | "viewport-aux"
  | "panel-right"
  | "panel-bottom"
  | "status-bar"
  | "overlay";

export type ModuleId = string;
type CapabilityKey = string;
export type ModuleConfig = Record<string, unknown>;

export interface ModuleProps {
  kernel: KernelApi;
  moduleId: ModuleId;
  slotId: SlotId;
  config: ModuleConfig;
  setConfig: (patch: Partial<ModuleConfig>) => void;
}

export interface ModuleManifest {
  id: ModuleId;
  title: string;
  version: string;
  slots: SlotId[];
  capabilityGate?: CapabilityKey[];
  component: () => Promise<{ default: ComponentType<ModuleProps> }>;
  /** Declarative contributions — auto-registered by the kernel on module load. */
  contributes?: {
    commands?: CommandContribution[];
  };
  emits?: Array<keyof KernelEventMap>;
  listens?: Array<keyof KernelEventMap>;
}

export interface KernelApi {
  readonly api: ControlRoomApi;
  readonly analysisFieldOverlay: AnalysisFieldOverlayController;
  readonly bus: EventBus<KernelEventMap>;
  readonly cameraRegistry: CameraRegistryController;
  readonly commandDiagnostics: CommandDiagnosticsController;
  readonly commands: CommandRegistry;
  readonly diagnostics: RequestDiagnosticsController;
  readonly diagnosticRecorder: DiagnosticRecorderController;
  readonly modules: ModuleRegistry;
  readonly realtime: RealtimeInvalidationBridge;
  readonly resources: ResourceInvalidationController;
  readonly selection: SelectionController;
  readonly visualization: ObjectVisualizationController;
  readonly visualizationDebug: VisualizationDebugController;
  readonly visualizationSync: VisualizationRegistrySyncController;
  readonly layout: LayoutController;
}

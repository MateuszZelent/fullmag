import type { ComponentType } from "react";

import type { ControlRoomApi } from "./api/ControlRoomApi";
import type { RequestDiagnosticsController } from "./api/RequestDiagnosticsController";
import type { CommandContribution } from "./commands/commandTypes";
import type { CommandRegistry } from "./commands/CommandRegistry";
import type { EventBus } from "./events/EventBus";
import type { KernelEventMap } from "./events/eventTypes";
import type { LayoutController } from "./layout/LayoutController";
import type { ModuleRegistry } from "./module/ModuleRegistry";
import type { RealtimeInvalidationBridge } from "./realtime/RealtimeInvalidationBridge";
import type { ResourceInvalidationController } from "./resources/ResourceInvalidationController";
import type { SelectionController } from "./selection/SelectionController";
import type { ObjectVisualizationController } from "./visualization/ObjectVisualizationController";
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
  readonly bus: EventBus<KernelEventMap>;
  readonly commands: CommandRegistry;
  readonly diagnostics: RequestDiagnosticsController;
  readonly modules: ModuleRegistry;
  readonly realtime: RealtimeInvalidationBridge;
  readonly resources: ResourceInvalidationController;
  readonly selection: SelectionController;
  readonly visualization: ObjectVisualizationController;
  readonly visualizationSync: VisualizationRegistrySyncController;
  readonly layout: LayoutController;
}

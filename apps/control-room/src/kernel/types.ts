import type { ComponentType } from "react";

import type { CommandRegistry } from "./commands/CommandRegistry";
import type { EventBus } from "./events/EventBus";
import type { KernelEventMap } from "./events/eventTypes";
import type { ModuleRegistry } from "./module/ModuleRegistry";

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
export type CapabilityKey = string;
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
  emits?: Array<keyof KernelEventMap>;
  listens?: Array<keyof KernelEventMap>;
}

export interface KernelApi {
  readonly bus: EventBus<KernelEventMap>;
  readonly commands: CommandRegistry;
  readonly modules: ModuleRegistry;
}

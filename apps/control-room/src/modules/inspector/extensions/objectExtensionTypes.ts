import type { Selection } from "@/kernel/selection/selectionTypes";

export type ObjectExtensionId = "topological_charge";

export type ObjectExtensionStatus = "disabled" | "enabled";

export interface ObjectExtensionDefinition {
  id: ObjectExtensionId;
  label: string;
  description: string;
  defaultEnabled: boolean;
  isAvailable(selection: Selection): boolean;
}

export interface ObjectExtensionActivationState {
  enabled: Partial<Record<string, boolean>>;
}

export interface ObjectExtensionRowModel {
  enabled: boolean;
  id: ObjectExtensionId;
  label: string;
  status: ObjectExtensionStatus;
  summary: string;
}

export interface ObjectExtensionsSectionModel {
  activeCount: number;
  badge: string | undefined;
  extensions: ObjectExtensionRowModel[];
  visible: boolean;
}

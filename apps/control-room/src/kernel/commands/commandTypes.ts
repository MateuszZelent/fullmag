import type { ReactNode } from "react";

import type { ControlRoomApi } from "../api/ControlRoomApi";
import type { LayoutController } from "../layout/LayoutController";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import type { SelectionController } from "../selection/SelectionController";
import type { AnalysisFieldOverlayController } from "../visualization/AnalysisFieldOverlayController";
import type { ChartViewportHandoffController } from "../visualization/ChartViewportHandoffController";
import type { CameraRegistryController } from "../visualization/CameraRegistryController";
import type { ObjectVisualizationController } from "../visualization/ObjectVisualizationController";
import type { VisualizationRegistrySyncController } from "../visualization/VisualizationRegistrySyncController";
import type { VisualizationTargetRef } from "../visualization/ObjectVisualizationController";
import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { ObjectMoveToolController } from "../authoring/ObjectMoveToolController";

export type CommandId = string;
type CommandGroupId = string;
export type CommandCategory = string;

export interface CommandContext {
  source:
    | "explorer"
    | "analysis-plots"
    | "live-charts"
    | "inspector"
    | "menu"
    | "palette"
    | "ribbon"
    | "shortcut"
    | "test";
  api?: ControlRoomApi;
  analysisFieldOverlay?: AnalysisFieldOverlayController;
  bus?: EventBus<KernelEventMap>;
  chartViewportHandoff?: ChartViewportHandoffController;
  cameraRegistry?: CameraRegistryController;
  input?: unknown;
  layout?: LayoutController;
  objectMoveTool?: ObjectMoveToolController;
  resourceData?: Readonly<Record<string, unknown>>;
  resources?: ResourceInvalidationController;
  selection?: SelectionController;
  sourceDetail?: string;
  visualization?: ObjectVisualizationController;
  visualizationSync?: VisualizationRegistrySyncController;
  /** Canonical target resolved by a UI surface with scene and mesh provenance. */
  visualizationTarget?: VisualizationTargetRef | null;
}

export interface CommandResult {
  status: "completed" | "failed" | "cancelled";
  message?: string;
}

export interface CommandActiveResource {
  kind: "command";
  commandId: string;
  label?: string;
}

export interface CommandContribution {
  id: CommandId;
  title: string;
  group: CommandGroupId;
  category?: CommandCategory;
  scope: "global" | "workspace" | "selection" | "viewport" | "runtime" | "debug";
  icon?: ReactNode;
  shortcut?: string;
  /** Requires a contextual input that the global command palette cannot provide. */
  requiresInput?: boolean;
  /** When absent the command is always enabled. */
  isEnabled?: (context: CommandContext) => boolean;
  /** User-facing explanation when `isEnabled` returns false. */
  disabledReason?: (context: CommandContext) => string | null;
  /** When absent the command is rendered inactive. */
  isActive?: (context: CommandContext) => boolean;
  /** Optional resource backing the active command state. */
  activeResource?: (context: CommandContext) => CommandActiveResource | null;
  run: (context: CommandContext) => CommandResult | Promise<CommandResult>;
}

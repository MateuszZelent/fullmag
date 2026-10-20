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
import type { AuthoringHistoryController } from "../authoring/AuthoringHistoryController";
import type { ObjectEditSessionController } from "../authoring/object-edit/ObjectEditSessionController";
import type { GeometryObjectDraft } from "../authoring/object-edit/objectEditTypes";
import type { PendingFormRegistry } from "../authoring/PendingFormRegistry";
import type { ProjectDocumentController } from "../persistence/ProjectDocumentController";

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
  authoringHistory?: AuthoringHistoryController;
  pendingForms?: PendingFormRegistry;
  objectEditSession?: ObjectEditSessionController<GeometryObjectDraft>;
  bus?: EventBus<KernelEventMap>;
  chartViewportHandoff?: ChartViewportHandoffController;
  cameraRegistry?: CameraRegistryController;
  input?: unknown;
  layout?: LayoutController;
  objectMoveTool?: ObjectMoveToolController;
  projectDocument?: ProjectDocumentController;
  resourceData?: Readonly<Record<string, unknown>>;
  resources?: ResourceInvalidationController;
  /** Session identity used to partition current-session API request coalescing. */
  sessionScopeKey?: string | null;
  /** Recheck after await before applying a session-owned UI effect. */
  isCurrentSessionScope?: () => boolean;
  selection?: SelectionController;
  sourceDetail?: string;
  /**
   * Who presents the outcome to the user. `local` means the invoking surface
   * renders the result inline (e.g. an Inspector status line); `foreground`
   * routes failures, disabled/missing admissions and pending ACKs to the shell
   * feedback presenter. When absent it is derived from `source`
   * (see `defaultCommandFeedbackOwner`).
   */
  feedback?: CommandFeedbackOwner;
  visualization?: ObjectVisualizationController;
  visualizationSync?: VisualizationRegistrySyncController;
  /** Canonical target resolved by a UI surface with scene and mesh provenance. */
  visualizationTarget?: VisualizationTargetRef | null;
}

export type CommandFeedbackOwner = "foreground" | "local";

/** Terminal outcome of one `CommandRegistry.execute` invocation. */
export type CommandOutcomeStatus =
  | "cancelled"
  | "completed"
  | "disabled"
  | "failed"
  | "missing"
  | "pending";

const LOCALLY_PRESENTED_SOURCES = new Set<CommandContext["source"]>([
  "analysis-plots",
  "inspector",
  "live-charts",
  "test",
]);

/**
 * Surfaces that render command results inline own their presentation; menu,
 * ribbon, shortcut, palette and explorer invocations have no inline result
 * surface, so their outcomes are foreground feedback.
 */
export function defaultCommandFeedbackOwner(
  source: CommandContext["source"],
): CommandFeedbackOwner {
  return LOCALLY_PRESENTED_SOURCES.has(source) ? "local" : "foreground";
}

export interface CommandResult {
  status: "completed" | "failed" | "cancelled" | "pending";
  commandId?: string;
  observation?: "waiting" | "disconnected" | "publication-unconfirmed";
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

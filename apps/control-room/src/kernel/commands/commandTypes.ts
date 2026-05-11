import type { ReactNode } from "react";

import type { ControlRoomApi } from "../api/ControlRoomApi";
import type { LayoutController } from "../layout/LayoutController";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import type { SelectionController } from "../selection/SelectionController";
import type { ObjectVisualizationController } from "../visualization/ObjectVisualizationController";

export type CommandId = string;
export type CommandGroupId = string;
export type CommandCategory = string;

export interface CommandContext {
  source: "menu" | "ribbon" | "shortcut" | "palette" | "test";
  api?: ControlRoomApi;
  layout?: LayoutController;
  resourceData?: Readonly<Record<string, unknown>>;
  resources?: ResourceInvalidationController;
  selection?: SelectionController;
  visualization?: ObjectVisualizationController;
}

export interface CommandResult {
  status: "completed" | "failed" | "cancelled";
  message?: string;
}

export interface CommandContribution {
  id: CommandId;
  title: string;
  group: CommandGroupId;
  category?: CommandCategory;
  scope: "global" | "workspace" | "selection" | "viewport" | "runtime" | "debug";
  icon?: ReactNode;
  shortcut?: string;
  /** When absent the command is always enabled. */
  isEnabled?: (context: CommandContext) => boolean;
  /** User-facing explanation when `isEnabled` returns false. */
  disabledReason?: (context: CommandContext) => string | null;
  /** When absent the command is rendered inactive. */
  isActive?: (context: CommandContext) => boolean;
  run: (context: CommandContext) => CommandResult | Promise<CommandResult>;
}

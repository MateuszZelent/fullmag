import type { ReactNode } from "react";

import type { LayoutController } from "../layout/LayoutController";
import type { SelectionController } from "../selection/SelectionController";

export type CommandId = string;
export type CommandGroupId = string;
export type CommandCategory = string;

export interface CommandContext {
  source: "menu" | "ribbon" | "shortcut" | "palette" | "test";
  layout?: LayoutController;
  selection?: SelectionController;
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
  /** When absent the command is rendered inactive. */
  isActive?: (context: CommandContext) => boolean;
  run: (context: CommandContext) => CommandResult | Promise<CommandResult>;
}

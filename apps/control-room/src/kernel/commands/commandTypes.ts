export type CommandId = string;
export type CommandGroupId = string;

export interface CommandContext {
  source: "menu" | "ribbon" | "shortcut" | "palette" | "test";
}

export interface CommandResult {
  status: "completed" | "failed" | "cancelled";
  message?: string;
}

export interface CommandContribution {
  id: CommandId;
  title: string;
  group: CommandGroupId;
  scope: "global" | "workspace" | "selection" | "viewport" | "runtime" | "debug";
  run: (context: CommandContext) => CommandResult | Promise<CommandResult>;
}

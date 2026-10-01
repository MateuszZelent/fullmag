// Runtime-free commands allowed without a confirmed available session.
const PROJECT_WORKSPACE_COMMAND_IDS = new Set([
  "workspace.new-project",
  "workspace.open-project",
  "workspace.save-project",
  "workspace.close-project",
  "workspace.new-problem",
  "workspace.theme-toggle",
  "panels:explorer:toggle",
  "panels:inspector:toggle",
  "panels", // Menu container; it is not an executable command.
]);

export function isProjectWorkspaceCommand(commandId: string): boolean {
  return PROJECT_WORKSPACE_COMMAND_IDS.has(commandId);
}

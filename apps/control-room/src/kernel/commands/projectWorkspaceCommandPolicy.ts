// Runtime-free commands allowed without a confirmed available session.
// The start.* ids mirror START_COMMANDS in the start-screen module; the kernel
// cannot import module internals, so a module test keeps the two in step.
const PROJECT_WORKSPACE_COMMAND_IDS = new Set([
  "workspace.new-project",
  "workspace.open-project",
  "workspace.save-project",
  "workspace.close-project",
  "workspace.home",
  "workspace.new-problem",
  "workspace.theme-toggle",
  "workspace.command-palette",
  "panels:explorer:toggle",
  "panels:inspector:toggle",
  "panels", // Menu container; it is not an executable command.
  "start.section.home",
  "start.section.templates",
  "start.section.import",
  "start.section.learn",
  "start.section.docs",
  "workspace.search-docs",
  "start.section.settings",
  "start.section.about",
  "start.templates",
  "start.import",
  "start.new-fdm",
  "start.new-fem",
  "start.browse",
  "start.search",
  "start.rebuild-index",
  "start.open-selected",
  "start.pin-selected",
  "start.remove-selected",
]);

export function isProjectWorkspaceCommand(commandId: string): boolean {
  return PROJECT_WORKSPACE_COMMAND_IDS.has(commandId);
}

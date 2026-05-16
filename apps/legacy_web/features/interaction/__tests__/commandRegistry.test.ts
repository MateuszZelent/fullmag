import { beforeEach, describe, expect, it } from "vitest";
import {
  registerCommand,
  unregisterCommand,
  getCommand,
  getAllCommands,
  getCommandsForGroup,
  getCommandsForContext,
  executeCommand,
} from "../commands/commandRegistry";
import type { CommandDefinition, CommandContext } from "../commands/commandRegistry";
import { EMPTY_SELECTION } from "../model/selection";
import { DEFAULT_VIEWPORT_INTERACTION } from "../model/viewportInteraction";
import { INITIAL_DIRTY_GRAPH } from "../model/dirtyGraph";

// Minimal context for tests
const CTX: CommandContext = {
  selection: EMPTY_SELECTION,
  viewport: DEFAULT_VIEWPORT_INTERACTION,
  dirtyGraph: INITIAL_DIRTY_GRAPH,
  runGate: { canRun: false, canRelax: false, blockers: [] },
};

describe("commandRegistry", () => {
  const testCmd: CommandDefinition = {
    id: "test.cmd",
    label: "Test Command",
    group: "test",
    getState: () => ({ enabled: true }),
    execute: async () => {},
  };

  beforeEach(() => {
    // Clean up
    unregisterCommand("test.cmd");
    unregisterCommand("test.cmd2");
  });

  it("registers and retrieves a command", () => {
    registerCommand(testCmd);
    expect(getCommand("test.cmd")).toBe(testCmd);
  });

  it("returns undefined for unknown command", () => {
    expect(getCommand("nonexistent")).toBeUndefined();
  });

  it("lists all registered commands", () => {
    registerCommand(testCmd);
    const all = getAllCommands();
    expect(all.some((c) => c.id === "test.cmd")).toBe(true);
  });

  it("filters by group", () => {
    registerCommand(testCmd);
    const group = getCommandsForGroup("test");
    expect(group).toHaveLength(1);
    expect(group[0].id).toBe("test.cmd");
  });

  it("returns empty array for unknown group", () => {
    expect(getCommandsForGroup("nonexistent")).toHaveLength(0);
  });

  it("getCommandsForContext filters by isVisible", () => {
    const visible: CommandDefinition = {
      id: "test.cmd",
      label: "Visible",
      group: "test",
      isVisible: () => true,
      getState: () => ({ enabled: true }),
      execute: async () => {},
    };
    const hidden: CommandDefinition = {
      id: "test.cmd2",
      label: "Hidden",
      group: "test",
      isVisible: () => false,
      getState: () => ({ enabled: true }),
      execute: async () => {},
    };

    registerCommand(visible);
    registerCommand(hidden);

    const cmds = getCommandsForContext(CTX);
    expect(cmds.some((c) => c.id === "test.cmd")).toBe(true);
    expect(cmds.some((c) => c.id === "test.cmd2")).toBe(false);
  });

  it("unregisters a command", () => {
    registerCommand(testCmd);
    unregisterCommand("test.cmd");
    expect(getCommand("test.cmd")).toBeUndefined();
  });

  it("executeCommand runs the handler", async () => {
    let ran = false;
    registerCommand({
      ...testCmd,
      execute: async () => { ran = true; },
    });
    await executeCommand("test.cmd", CTX);
    expect(ran).toBe(true);
  });
});

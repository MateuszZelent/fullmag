import { describe, expect, it, vi } from "vitest";

import type { CommandContext } from "../commands/commandTypes";

import { SHELL_COMMANDS } from "./shellCommands";

describe("SHELL_COMMANDS", () => {
  it("registers a real focus command for explorer context menus", () => {
    const command = SHELL_COMMANDS.find(
      (candidate) => candidate.id === "workspace.focus-selection",
    );
    const setActiveTab = vi.fn();
    const setFocusedSlot = vi.fn();

    expect(command).toBeDefined();
    expect(command?.group).not.toBe("workspace-placeholder");

    const result = command?.run({
      layout: { setActiveTab, setFocusedSlot } as unknown as CommandContext["layout"],
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(setActiveTab).toHaveBeenCalledWith("view");
    expect(setFocusedSlot).toHaveBeenCalledWith("viewport-main");
  });
});

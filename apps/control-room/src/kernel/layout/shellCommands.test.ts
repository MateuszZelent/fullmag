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

  it("exports the canonical Python source through the model API", async () => {
    const command = SHELL_COMMANDS.find(
      (candidate) => candidate.id === "workspace.export-python",
    );
    const syncAuthoringScript = vi.fn(async () => ({
      bytes_written: 81,
      entrypoint_kind: "flat_workspace",
      script_path: "/tmp/example.py",
      source_kind: "canonical",
      written: true,
    }));
    const authoringScript = vi.fn(async () => ({
      bytes: 81,
      script_path: "/tmp/example.py",
      source:
        'study.stages.tableautosave("auto")\nstudy.stages.autosave("m", every="auto")\n',
    }));

    expect(command).toBeDefined();
    expect(command?.group).not.toBe("workspace-placeholder");

    const result = await command?.run({
      api: {
        model: { authoringScript, syncAuthoringScript },
      } as unknown as CommandContext["api"],
      source: "test",
    });

    expect(syncAuthoringScript).toHaveBeenCalledWith({});
    expect(authoringScript).toHaveBeenCalledWith();
    expect(result).toEqual({
      message: "Canonical Python exported from /tmp/example.py.",
      status: "completed",
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import type { CommandContext } from "../commands/commandTypes";
import { PendingFormRegistry } from "../authoring/PendingFormRegistry";

import { SHELL_COMMANDS } from "./shellCommands";

describe("SHELL_COMMANDS", () => {
  const projectResource = {
    name: "Demo project",
    mode: { kind: "read_write" as const },
  };

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

  it("uses the shared panel command when the Inspector header hides the panel", () => {
    const command = SHELL_COMMANDS.find(
      (candidate) => candidate.id === "panels:inspector:toggle",
    );
    const togglePanel = vi.fn();

    expect(command).toBeDefined();
    const result = command?.run({
      layout: { togglePanel } as unknown as CommandContext["layout"],
      source: "inspector",
    });

    expect(result).toEqual({ status: "completed" });
    expect(togglePanel).toHaveBeenCalledWith("right");
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

  it("connects New/Open/Save to the shared project document controller", async () => {
    const create = vi.fn(async () => projectResource);
    const open = vi.fn(async () => projectResource);
    const save = vi.fn();
    const projectDocument = {
      canSave: () => true,
      create,
      open,
      save,
    } as unknown as CommandContext["projectDocument"];

    const newProject = SHELL_COMMANDS.find(
      (candidate) => candidate.id === "workspace.new-project",
    );
    const openProject = SHELL_COMMANDS.find(
      (candidate) => candidate.id === "workspace.open-project",
    );
    const saveProject = SHELL_COMMANDS.find(
      (candidate) => candidate.id === "workspace.save-project",
    );
    const closeProject = SHELL_COMMANDS.find(
      (candidate) => candidate.id === "workspace.close-project",
    );

    await expect(
      newProject?.run({ projectDocument, source: "test", input: { name: "Demo project" } }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      openProject?.run({
        projectDocument,
        source: "test",
        input: { bytes: new Uint8Array([1]), fileName: "demo.fms" },
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      saveProject?.run({ projectDocument, source: "test" }),
    ).resolves.toEqual({
      message: "Project archive downloaded.",
      status: "completed",
    });
    const close = vi.fn(() => true);
    const closeDocument = {
      ...projectDocument,
      close,
      getSnapshot: () => ({ state: "ready" }),
    } as unknown as CommandContext["projectDocument"];
    expect(
      closeProject?.run({ projectDocument: closeDocument, source: "test", input: { discardChanges: true } }),
    ).toEqual({ message: "Project closed.", status: "completed" });
    expect(create).toHaveBeenCalledWith("Demo project");
    expect(open).toHaveBeenCalledWith({ bytes: new Uint8Array([1]), fileName: "demo.fms" });
    expect(save).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(true);
  });

  it("uses a deterministic browser fallback when native prompt is unavailable", async () => {
    const create = vi.fn(async () => projectResource);
    const projectDocument = {
      canSave: () => false,
      create,
    } as unknown as CommandContext["projectDocument"];
    vi.stubGlobal("window", {});
    try {
      const newProject = SHELL_COMMANDS.find(
        (candidate) => candidate.id === "workspace.new-project",
      );
      await expect(newProject?.run({ projectDocument, source: "test" })).resolves.toMatchObject({
        status: "completed",
      });
      expect(create).toHaveBeenCalledWith("Untitled project");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes shared Inspector Apply and Reset commands through the pending-form registry", async () => {
    const registry = new PendingFormRegistry();
    const apply = vi.fn(async () => true);
    const reset = vi.fn(async () => undefined);
    registry.register(Symbol("inspector"), {
      apply,
      applying: false,
      dirty: true,
      mode: "staged",
      reset,
      valid: true,
    });
    const applyCommand = SHELL_COMMANDS.find(
      (candidate) => candidate.id === "workspace.apply-inspector",
    );
    const resetCommand = SHELL_COMMANDS.find(
      (candidate) => candidate.id === "workspace.reset-inspector",
    );

    expect(applyCommand?.isEnabled?.({ source: "test", pendingForms: registry })).toBe(true);
    await expect(
      applyCommand?.run({ source: "test", pendingForms: registry }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      resetCommand?.run({ source: "test", pendingForms: registry }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(apply).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });
});

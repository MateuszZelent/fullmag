import { describe, expect, it } from "vitest";

import { CommandRegistry } from "./CommandRegistry";
import type { CommandContribution } from "./commandTypes";
import {
  dispatchShortcutCommand,
  findShortcutCommand,
  isEditableShortcutTarget,
  matchesCommandShortcut,
} from "./commandShortcuts";

function command(
  id: string,
  shortcut?: string,
): CommandContribution {
  return {
    id,
    group: "test",
    scope: "global",
    shortcut,
    title: id,
    run: () => ({ status: "completed" }),
  };
}

describe("commandShortcuts", () => {
  it("matches plain and modified shortcuts case-insensitively", () => {
    expect(matchesCommandShortcut("F", { key: "f" })).toBe(true);
    expect(matchesCommandShortcut("F", { key: "f", metaKey: true })).toBe(false);
    expect(matchesCommandShortcut("Space", { key: " " })).toBe(true);
    expect(
      matchesCommandShortcut("Ctrl+Shift+Enter", {
        ctrlKey: true,
        key: "Enter",
        shiftKey: true,
      }),
    ).toBe(true);
    expect(
      matchesCommandShortcut("Ctrl+Shift+Enter", {
        ctrlKey: true,
        key: "Enter",
      }),
    ).toBe(false);
  });

  it("treats meta as ctrl-compatible for platform shortcuts", () => {
    expect(
      matchesCommandShortcut("Ctrl+Enter", {
        key: "Enter",
        metaKey: true,
      }),
    ).toBe(true);
  });

  it("finds the first command matching a keyboard event", () => {
    expect(
      findShortcutCommand(
        [command("one"), command("two", "Shift+F")],
        { key: "f", shiftKey: true },
      )?.id,
    ).toBe("two");
  });

  it("resolves shortcut conflicts by command scope before registration order", () => {
    expect(
      findShortcutCommand(
        [
          command("global", "F"),
          { ...command("workspace", "F"), scope: "workspace" },
          { ...command("viewport", "F"), scope: "viewport" },
        ],
        { key: "f" },
      )?.id,
    ).toBe("viewport");
  });

  it("ignores editable shortcut targets", () => {
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    const div = {
      getAttribute: (name: string) => name === "contenteditable" ? "true" : null,
      tagName: "DIV",
    } as unknown as EventTarget;
    const button = { tagName: "BUTTON" } as unknown as EventTarget;

    expect(isEditableShortcutTarget(input)).toBe(true);
    expect(isEditableShortcutTarget(div)).toBe(true);
    expect(isEditableShortcutTarget(button)).toBe(false);
  });

  it("dispatches an enabled shortcut command and consumes the event", () => {
    const commands = new CommandRegistry();
    let executed = false;
    let prevented = false;
    commands.register({
      id: "geometry.focus-primitive",
      group: "geometry",
      scope: "selection",
      shortcut: "F",
      title: "Focus Primitive",
      run: () => {
        executed = true;
        return { status: "completed" };
      },
    });

    const handled = dispatchShortcutCommand(
      commands,
      {
        key: "f",
        preventDefault: () => {
          prevented = true;
        },
      },
      { source: "shortcut" },
    );

    expect(handled).toBe(true);
    expect(prevented).toBe(true);
    expect(executed).toBe(true);
  });

  it("does not consume editable or disabled shortcut commands", () => {
    const commands = new CommandRegistry();
    let executed = false;
    let prevented = false;
    commands.register({
      id: "mesh.build-selected",
      group: "mesh",
      scope: "selection",
      shortcut: "Ctrl+B",
      title: "Build Selected Mesh",
      isEnabled: () => false,
      run: () => {
        executed = true;
        return { status: "completed" };
      },
    });

    expect(
      dispatchShortcutCommand(
        commands,
        {
          ctrlKey: true,
          key: "b",
          preventDefault: () => {
            prevented = true;
          },
        },
        { source: "shortcut" },
      ),
    ).toBe(false);
    expect(prevented).toBe(false);
    expect(executed).toBe(false);

    const input = { tagName: "INPUT" } as unknown as EventTarget;
    expect(
      dispatchShortcutCommand(
        commands,
        {
          ctrlKey: true,
          key: "b",
          preventDefault: () => {
            prevented = true;
          },
          target: input,
        },
        { source: "shortcut" },
      ),
    ).toBe(false);
  });

  it("allows the registered global command palette shortcut from editable targets", () => {
    const commands = new CommandRegistry();
    let executions = 0;
    let prevented = 0;
    const palette = command("workspace.command-palette", "Ctrl+Shift+P");
    commands.register({
      ...palette,
      run: () => {
        executions += 1;
        return { status: "completed" };
      },
    });
    const editableTargets = [
      { tagName: "INPUT" },
      { tagName: "INPUT", type: "range" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
      {
        tagName: "DIV",
        getAttribute: (name: string) => name === "contenteditable" ? "true" : null,
      },
    ] as unknown as EventTarget[];

    for (const target of editableTargets) {
      expect(
        dispatchShortcutCommand(
          commands,
          {
            ctrlKey: true,
            shiftKey: true,
            key: "p",
            target,
            preventDefault: () => {
              prevented += 1;
            },
          },
          { source: "shortcut" },
        ),
      ).toBe(true);
    }

    expect(executions).toBe(editableTargets.length);
    expect(prevented).toBe(editableTargets.length);
  });

  it("keeps disabled and already-prevented palette shortcuts blocked from editable targets", () => {
    const disabledCommands = new CommandRegistry();
    let disabledExecutions = 0;
    let disabledPrevented = false;
    disabledCommands.register({
      ...command("workspace.command-palette", "Ctrl+Shift+P"),
      isEnabled: () => false,
      run: () => {
        disabledExecutions += 1;
        return { status: "completed" };
      },
    });
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    expect(
      dispatchShortcutCommand(
        disabledCommands,
        {
          ctrlKey: true,
          shiftKey: true,
          key: "p",
          target: input,
          preventDefault: () => {
            disabledPrevented = true;
          },
        },
        { source: "shortcut" },
      ),
    ).toBe(false);
    expect(disabledExecutions).toBe(0);
    expect(disabledPrevented).toBe(false);

    const enabledCommands = new CommandRegistry();
    let enabledExecutions = 0;
    let prevented = false;
    enabledCommands.register({
      ...command("workspace.command-palette", "Ctrl+Shift+P"),
      run: () => {
        enabledExecutions += 1;
        return { status: "completed" };
      },
    });
    expect(
      dispatchShortcutCommand(
        enabledCommands,
        {
          ctrlKey: true,
          shiftKey: true,
          key: "p",
          target: input,
          defaultPrevented: true,
          preventDefault: () => {
            prevented = true;
          },
        },
        { source: "shortcut" },
      ),
    ).toBe(false);
    expect(enabledExecutions).toBe(0);
    expect(prevented).toBe(false);
  });

  it("still blocks enabled scientific shortcuts from editable targets", () => {
    const commands = new CommandRegistry();
    let executed = false;
    let prevented = false;
    commands.register({
      ...command("mesh.build-selected", "Ctrl+B"),
      scope: "selection",
      run: () => {
        executed = true;
        return { status: "completed" };
      },
    });

    expect(
      dispatchShortcutCommand(
        commands,
        {
          ctrlKey: true,
          key: "b",
          target: { tagName: "INPUT" } as unknown as EventTarget,
          preventDefault: () => {
            prevented = true;
          },
        },
        { source: "shortcut" },
      ),
    ).toBe(false);
    expect(executed).toBe(false);
    expect(prevented).toBe(false);
  });

  it("ignores already-prevented shortcut events", () => {
    const commands = new CommandRegistry();
    let executed = false;
    commands.register({
      id: "shell.toggle-theme",
      group: "shell",
      scope: "global",
      shortcut: "T",
      title: "Toggle Theme",
      run: () => {
        executed = true;
        return { status: "completed" };
      },
    });

    expect(
      dispatchShortcutCommand(
        commands,
        { defaultPrevented: true, key: "t" },
        { source: "shortcut" },
      ),
    ).toBe(false);
    expect(executed).toBe(false);
  });

  it("falls back to an enabled lower-priority shortcut command", () => {
    const commands = new CommandRegistry();
    let executed = "";
    commands.register({
      id: "viewport.fit-selected",
      group: "viewport",
      scope: "viewport",
      shortcut: "F",
      title: "Fit Selected",
      isEnabled: () => false,
      run: () => {
        executed = "viewport";
        return { status: "completed" };
      },
    });
    commands.register({
      id: "geometry.focus-primitive",
      group: "geometry",
      scope: "selection",
      shortcut: "F",
      title: "Focus Primitive",
      run: () => {
        executed = "selection";
        return { status: "completed" };
      },
    });

    expect(
      dispatchShortcutCommand(commands, { key: "f" }, { source: "shortcut" }),
    ).toBe(true);
    expect(executed).toBe("selection");
  });
});

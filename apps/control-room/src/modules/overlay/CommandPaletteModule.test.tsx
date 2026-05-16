import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "@/kernel/commands/CommandRegistry";

import { commandPaletteStore } from "./commandPaletteStore";
import {
  CommandPaletteView,
  executePaletteCommand,
  filterPaletteCommands,
  resolvePaletteCommandItems,
} from "./CommandPaletteModule";
import { overlayManifest } from "./manifest";

describe("CommandPaletteModule", () => {
  it("renders all registered commands when open", () => {
    const commands = new CommandRegistry();
    commands.register({
      id: "workspace.command-palette",
      title: "Command Palette",
      group: "workspace",
      scope: "global",
      shortcut: "Ctrl+Shift+P",
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "explorer.expand-all",
      title: "Expand Explorer",
      group: "explorer",
      scope: "workspace",
      run: () => ({ status: "completed" }),
    });

    const html = renderToStaticMarkup(
      <CommandPaletteView
        commands={commands.all()}
        isOpen
        query=""
        onClose={() => undefined}
        onExecute={() => undefined}
        onQueryChange={() => undefined}
      />,
    );

    expect(html).toContain("Command Palette");
    expect(html).toContain("Expand Explorer");
    expect(html).toContain("Ctrl+Shift+P");
  });

  it("renders disabled command reasons from the active command context", () => {
    const commands = new CommandRegistry();
    commands.register({
      disabledReason: () => "Session status is unavailable.",
      group: "study",
      id: "study.run",
      isEnabled: () => false,
      scope: "runtime",
      title: "Compute Study",
      run: () => ({ status: "completed" }),
    });

    const html = renderToStaticMarkup(
      <CommandPaletteView
        commandContext={{ source: "palette" }}
        commands={commands.all()}
        isOpen
        query=""
        onClose={() => undefined}
        onExecute={() => undefined}
        onQueryChange={() => undefined}
      />,
    );

    expect(html).toContain("Compute Study");
    expect(html).toContain("Session status is unavailable.");
  });

  it("filters by title, group, shortcut, and id", () => {
    const commands = [
      {
        id: "workspace.command-palette",
        title: "Command Palette",
        group: "workspace",
        scope: "global" as const,
        shortcut: "Ctrl+Shift+P",
        run: () => ({ status: "completed" as const }),
      },
      {
        id: "explorer.collapse-all",
        title: "Collapse Explorer",
        group: "explorer",
        scope: "workspace" as const,
        run: () => ({ status: "completed" as const }),
      },
    ];

    expect(filterPaletteCommands(commands, "shift p")).toHaveLength(1);
    expect(filterPaletteCommands(commands, "explorer")).toHaveLength(1);
    expect(filterPaletteCommands(commands, "collapse")[0]?.id).toBe(
      "explorer.collapse-all",
    );
  });

  it("executes commands through the kernel command registry", async () => {
    const commands = new CommandRegistry();
    const run = vi.fn(() => ({ status: "completed" as const }));
    commands.register({
      id: "explorer.expand-all",
      title: "Expand Explorer",
      group: "explorer",
      scope: "workspace",
      run,
    });

    await executePaletteCommand(commands, "explorer.expand-all", {
      source: "palette",
    });

    expect(run).toHaveBeenCalledWith({ source: "palette" });
  });

  it("resolves disabled command state for palette parity with other renderers", () => {
    const items = resolvePaletteCommandItems(
      [
        {
          disabledReason: () => "Runtime is already active.",
          group: "study",
          id: "study.run",
          isEnabled: () => false,
          scope: "runtime",
          title: "Compute Study",
          run: () => ({ status: "completed" }),
        },
      ],
      { source: "palette" },
    );

    expect(items).toEqual([
      expect.objectContaining({
        disabled: true,
        disabledReason: "Runtime is already active.",
      }),
    ]);
  });

  it("resolves active command state for palette parity with other renderers", () => {
    const items = resolvePaletteCommandItems(
      [
        {
          activeResource: () => ({
            commandId: "cmd-run",
            kind: "command",
          }),
          group: "study",
          id: "study.run",
          isActive: () => true,
          scope: "runtime",
          title: "Compute Study",
          run: () => ({ status: "completed" }),
        },
      ],
      { source: "palette" },
    );

    expect(items).toEqual([
      expect.objectContaining({
        active: true,
        activeResource: expect.objectContaining({ commandId: "cmd-run" }),
        disabled: false,
      }),
    ]);
  });

  it("renders active command badges in the palette", () => {
    const commands = new CommandRegistry();
    commands.register({
      group: "study",
      id: "study.run",
      activeResource: () => ({
        commandId: "cmd-run",
        kind: "command",
      }),
      isActive: () => true,
      scope: "runtime",
      title: "Compute Study",
      run: () => ({ status: "completed" }),
    });

    const html = renderToStaticMarkup(
      <CommandPaletteView
        commandContext={{ source: "palette" }}
        commands={commands.all()}
        isOpen
        query=""
        onClose={() => undefined}
        onExecute={() => undefined}
        onQueryChange={() => undefined}
      />,
    );

    expect(html).toContain("Compute Study");
    expect(html).toContain("active");
    expect(html).toContain("Detail");
    expect(html).toContain('data-active="true"');
  });

  it("keeps the command palette shortcut as a toggle command", () => {
    commandPaletteStore.close();
    const command = overlayManifest.contributes?.commands?.find(
      (item) => item.id === "workspace.command-palette",
    );

    expect(command?.shortcut).toBe("Ctrl+Shift+P");
    command?.run({ source: "shortcut" });
    expect(commandPaletteStore.getSnapshot().isOpen).toBe(true);
    command?.run({ source: "shortcut" });
    expect(commandPaletteStore.getSnapshot().isOpen).toBe(false);
  });
});

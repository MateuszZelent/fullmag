import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "@/kernel/commands/CommandRegistry";

import {
  CommandPaletteView,
  executePaletteCommand,
  filterPaletteCommands,
} from "./CommandPaletteModule";

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
});
